// =====================================================================
//  SERVICE : CoopCollectionsService
//  ---------------------------------------------------------------------
//  Planification + suivi des collectes internes membre → coop. La coop
//  va chercher la marchandise chez le farmer avant la pesée et le
//  stockage en entrepôt.
//
//  Statuts : PLANNED / IN_PROGRESS / COMPLETED / CANCELLED.
//  Soft cancel via DELETE → status=CANCELLED.
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { NotificationsService } from '@farmcash/notifications';
import {
  CoopCollectionStatus,
  CreateCoopCollectionDto,
  ListCoopCollectionsQueryDto,
  UpdateCoopCollectionDto,
} from './dto/collections.dto';

@Injectable()
export class CoopCollectionsService {
  private readonly logger = new Logger(CoopCollectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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

  async list(userId: string, query: ListCoopCollectionsQueryDto) {
    const coopId = await this.resolveCoopId(userId);
    return this.prisma.coop_collections.findMany({
      where: {
        cooperative_id: coopId,
        ...(query.status && { status: query.status }),
      },
      include: {
        users: {
          select: { id: true, full_name: true, phone: true, photo_url: true },
        },
        coop_vehicles: {
          select: {
            id: true,
            type: true,
            immatriculation: true,
            chauffeur_nom: true,
          },
        },
        annonces_vente: {
          select: { id: true, titre: true, quantite_kg: true },
        },
      },
      orderBy: { scheduled_at: 'asc' },
    });
  }

  async create(userId: string, dto: CreateCoopCollectionDto) {
    const coopId = await this.resolveCoopId(userId);

    // Vérifie l'existence du farmer
    const farmer = await this.prisma.users.findUnique({
      where: { id: dto.farmer_id },
      select: { id: true, role: true },
    });
    if (!farmer) throw new BadRequestException('Farmer introuvable.');

    // Si vehicle_id, doit appartenir à la coop et être actif
    if (dto.vehicle_id) {
      const vehicle = await this.prisma.coop_vehicles.findFirst({
        where: { id: dto.vehicle_id, cooperative_id: coopId },
      });
      if (!vehicle) {
        throw new BadRequestException('Véhicule introuvable dans votre parc.');
      }
      if (!vehicle.is_active) {
        throw new BadRequestException('Véhicule désactivé.');
      }
    }

    // Si annonce_vente_id, doit appartenir au farmer
    if (dto.annonce_vente_id) {
      const annonce = await this.prisma.annonces_vente.findUnique({
        where: { id: dto.annonce_vente_id },
        select: { id: true, farmer_id: true },
      });
      if (!annonce || annonce.farmer_id !== dto.farmer_id) {
        throw new BadRequestException(
          "Annonce de vente introuvable ou ne correspond pas au farmer.",
        );
      }
    }

    const created = await this.prisma.coop_collections.create({
      data: {
        cooperative_id: coopId,
        farmer_id: dto.farmer_id,
        annonce_vente_id: dto.annonce_vente_id,
        vehicle_id: dto.vehicle_id,
        scheduled_at: new Date(dto.scheduled_at),
        pickup_address: dto.pickup_address,
        quantite_prevue_kg: dto.quantite_prevue_kg,
        notes: dto.notes,
        status: CoopCollectionStatus.PLANNED,
      },
    });

    this.logger.log(
      `Collecte créée ${created.id} coop=${coopId} farmer=${dto.farmer_id}`,
    );

    // Notif au farmer
    try {
      await this.notifications.create({
        user_id: dto.farmer_id,
        type: 'SYSTEM',
        titre: 'Collecte planifiée',
        body: `Votre coopérative passera chercher ${dto.quantite_prevue_kg}kg le ${new Date(dto.scheduled_at).toLocaleDateString('fr-FR')}.`,
      } as any);
    } catch (err) {
      this.logger.warn(
        `Notif collecte ${created.id} KO: ${(err as Error).message}`,
      );
    }

    return created;
  }

  async update(userId: string, id: string, dto: UpdateCoopCollectionDto) {
    const coopId = await this.resolveCoopId(userId);
    const collection = await this.prisma.coop_collections.findFirst({
      where: { id, cooperative_id: coopId },
    });
    if (!collection) throw new NotFoundException('Collecte introuvable.');

    if (
      collection.status === CoopCollectionStatus.COMPLETED ||
      collection.status === CoopCollectionStatus.CANCELLED
    ) {
      throw new ConflictException(
        `Collecte au statut ${collection.status} — modification impossible.`,
      );
    }

    if (dto.vehicle_id) {
      const vehicle = await this.prisma.coop_vehicles.findFirst({
        where: { id: dto.vehicle_id, cooperative_id: coopId, is_active: true },
      });
      if (!vehicle) {
        throw new BadRequestException('Véhicule introuvable ou inactif.');
      }
    }

    const updated = await this.prisma.coop_collections.update({
      where: { id },
      data: {
        ...(dto.scheduled_at !== undefined && {
          scheduled_at: new Date(dto.scheduled_at),
        }),
        ...(dto.pickup_address !== undefined && {
          pickup_address: dto.pickup_address,
        }),
        ...(dto.quantite_prevue_kg !== undefined && {
          quantite_prevue_kg: dto.quantite_prevue_kg,
        }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.vehicle_id !== undefined && { vehicle_id: dto.vehicle_id }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        updated_at: new Date(),
      },
    });
    return updated;
  }

  async complete(userId: string, id: string) {
    const coopId = await this.resolveCoopId(userId);
    const collection = await this.prisma.coop_collections.findFirst({
      where: { id, cooperative_id: coopId },
    });
    if (!collection) throw new NotFoundException('Collecte introuvable.');
    if (collection.status === CoopCollectionStatus.COMPLETED) {
      throw new ConflictException('Collecte déjà complétée.');
    }
    if (collection.status === CoopCollectionStatus.CANCELLED) {
      throw new ConflictException('Collecte annulée — réouverture impossible.');
    }

    const now = new Date();
    const updated = await this.prisma.coop_collections.update({
      where: { id },
      data: {
        status: CoopCollectionStatus.COMPLETED,
        completed_at: now,
        updated_at: now,
      },
    });
    this.logger.log(`Collecte ${id} marquée COMPLETED par user=${userId}`);

    // Notif au farmer
    try {
      await this.notifications.create({
        user_id: collection.farmer_id,
        type: 'SYSTEM',
        titre: 'Collecte effectuée',
        body: `Votre marchandise a bien été récupérée par la coopérative.`,
      } as any);
    } catch (err) {
      this.logger.warn(
        `Notif complete-collecte ${id} KO: ${(err as Error).message}`,
      );
    }

    return updated;
  }

  /** Soft cancel → status=CANCELLED. */
  async cancel(userId: string, id: string) {
    const coopId = await this.resolveCoopId(userId);
    const collection = await this.prisma.coop_collections.findFirst({
      where: { id, cooperative_id: coopId },
    });
    if (!collection) throw new NotFoundException('Collecte introuvable.');
    if (collection.status === CoopCollectionStatus.COMPLETED) {
      throw new ConflictException('Collecte déjà complétée — annulation impossible.');
    }
    if (collection.status === CoopCollectionStatus.CANCELLED) {
      return { message: 'Déjà annulée.' };
    }

    await this.prisma.coop_collections.update({
      where: { id },
      data: { status: CoopCollectionStatus.CANCELLED, updated_at: new Date() },
    });
    this.logger.warn(`Collecte ${id} annulée par user=${userId}`);
    return { message: 'Collecte annulée.' };
  }
}
