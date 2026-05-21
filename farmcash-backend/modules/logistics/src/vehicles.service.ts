// =====================================================================
//  SERVICE : VehiclesService
//  ---------------------------------------------------------------------
//  Gère le parc véhicules d'un TRANSPORTER.
//  Conventions :
//   • DELETE = désactivation (is_active=false) pour préserver l'historique
//     des shipments rattachés à ce véhicule
//   • immatriculation est UNIQUE en DB → on intercepte P2002 si conflit
// =====================================================================

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicles.dto';

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getMine(transporterId: string) {
    return this.prisma.vehicles.findMany({
      where: { transporter_id: transporterId },
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
    });
  }

  async create(transporterId: string, dto: CreateVehicleDto) {
    try {
      const created = await this.prisma.vehicles.create({
        data: {
          transporter_id: transporterId,
          type: dto.type,
          immatriculation: dto.immatriculation,
          marque: dto.marque,
          charge_max_kg: dto.charge_max_kg,
          volume_m3: dto.volume_m3,
          photo_url: dto.photo_url,
          is_active: true,
        },
      });
      this.logger.log(`Véhicule créé ${created.id} pour ${transporterId}`);
      return { message: 'Véhicule enregistré.', id: created.id, vehicle: created };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Immatriculation déjà utilisée par un autre véhicule.',
        );
      }
      throw e;
    }
  }

  async update(transporterId: string, id: string, dto: UpdateVehicleDto) {
    const vehicle = await this.prisma.vehicles.findFirst({
      where: { id, transporter_id: transporterId },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.');

    try {
      const updated = await this.prisma.vehicles.update({
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
          ...(dto.volume_m3 !== undefined && { volume_m3: dto.volume_m3 }),
          ...(dto.photo_url !== undefined && { photo_url: dto.photo_url }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }),
          updated_at: new Date(),
        },
      });
      this.logger.log(`Véhicule modifié ${id}`);
      return { message: 'Véhicule mis à jour.', id, vehicle: updated };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Immatriculation déjà utilisée.');
      }
      throw e;
    }
  }

  /** DELETE = soft delete (is_active=false). */
  async remove(transporterId: string, id: string) {
    const vehicle = await this.prisma.vehicles.findFirst({
      where: { id, transporter_id: transporterId },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
    await this.prisma.vehicles.update({
      where: { id },
      data: { is_active: false, updated_at: new Date() },
    });
    this.logger.log(`Véhicule désactivé ${id}`);
    return { message: 'Véhicule désactivé.' };
  }
}
