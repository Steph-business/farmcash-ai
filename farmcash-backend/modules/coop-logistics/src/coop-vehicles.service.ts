// =====================================================================
//  SERVICE : CoopVehiclesService
//  ---------------------------------------------------------------------
//  CRUD du parc de véhicules d'une coopérative. L'identifiant de coop
//  est résolu depuis le JWT (user.cooperative_id) — jamais depuis le
//  client. Soft delete (is_active=false) pour préserver l'historique
//  des collectes rattachées au véhicule.
// =====================================================================

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import {
  CreateCoopVehicleDto,
  UpdateCoopVehicleDto,
} from './dto/vehicles.dto';

@Injectable()
export class CoopVehiclesService {
  private readonly logger = new Logger(CoopVehiclesService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async resolveCoopId(userId: string): Promise<string> {
    const coop = await this.prisma.cooperative_profiles.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!coop) {
      throw new ForbiddenException(
        'Compte non rattaché à une coopérative.',
      );
    }
    return coop.id;
  }

  async list(userId: string) {
    const coopId = await this.resolveCoopId(userId);
    return this.prisma.coop_vehicles.findMany({
      where: { cooperative_id: coopId },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
    });
  }

  async create(userId: string, dto: CreateCoopVehicleDto) {
    const coopId = await this.resolveCoopId(userId);
    try {
      const created = await this.prisma.coop_vehicles.create({
        data: {
          cooperative_id: coopId,
          type: dto.type,
          immatriculation: dto.immatriculation,
          marque: dto.marque,
          charge_max_kg: dto.charge_max_kg,
          chauffeur_nom: dto.chauffeur_nom,
          chauffeur_phone: dto.chauffeur_phone,
          is_active: true,
        },
      });
      this.logger.log(
        `Coop véhicule créé ${created.id} pour coop=${coopId}`,
      );
      return { message: 'Véhicule enregistré.', id: created.id, vehicle: created };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'Immatriculation déjà utilisée par un autre véhicule.',
        );
      }
      throw e;
    }
  }

  async update(userId: string, id: string, dto: UpdateCoopVehicleDto) {
    const coopId = await this.resolveCoopId(userId);
    const vehicle = await this.prisma.coop_vehicles.findFirst({
      where: { id, cooperative_id: coopId },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.');

    try {
      const updated = await this.prisma.coop_vehicles.update({
        where: { id },
        data: {
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.immatriculation !== undefined && {
            immatriculation: dto.immatriculation,
          }),
          ...(dto.marque !== undefined && { marque: dto.marque }),
          ...(dto.charge_max_kg !== undefined && {
            charge_max_kg: dto.charge_max_kg,
          }),
          ...(dto.chauffeur_nom !== undefined && {
            chauffeur_nom: dto.chauffeur_nom,
          }),
          ...(dto.chauffeur_phone !== undefined && {
            chauffeur_phone: dto.chauffeur_phone,
          }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }),
          updated_at: new Date(),
        },
      });
      this.logger.log(`Coop véhicule modifié ${id}`);
      return { message: 'Véhicule mis à jour.', id, vehicle: updated };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Immatriculation déjà utilisée.');
      }
      throw e;
    }
  }

  /** Soft delete (is_active = false) — préserve l'historique des collectes. */
  async remove(userId: string, id: string) {
    const coopId = await this.resolveCoopId(userId);
    const vehicle = await this.prisma.coop_vehicles.findFirst({
      where: { id, cooperative_id: coopId },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
    await this.prisma.coop_vehicles.update({
      where: { id },
      data: { is_active: false, updated_at: new Date() },
    });
    this.logger.log(`Coop véhicule désactivé ${id}`);
    return { message: 'Véhicule désactivé.' };
  }
}
