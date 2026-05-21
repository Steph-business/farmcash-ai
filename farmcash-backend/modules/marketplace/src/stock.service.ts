// =====================================================================
//  SERVICE : StockService
//  ---------------------------------------------------------------------
//  Gère les entrepôts (`entrepots`) et les lots (`lots`).
//
//  Règles métier :
//   • Un entrepôt appartient à un user (owner_id).
//   • Un lot de type INDIVIDUAL → farmer_id rempli, cooperative_id null.
//   • Un lot de type COOPERATIVE → cooperative_id rempli, farmer_id null.
//     L'id de coopérative provient du JWT (user.cooperative_id), pas
//     du user_id ni du DTO côté client.
// =====================================================================

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import {
  CreateEntrepotDto,
  CreateLotDto,
  LotType,
  UpdateEntrepotDto,
  UpdateLotDto,
} from './dto/stock.dto';

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  // ===================================================================
  //  ENTREPÔTS
  // ===================================================================

  async getMesEntrepots(userId: string) {
    return this.prisma.entrepots.findMany({
      where: { owner_id: userId, is_active: true },
      include: {
        regions_ci: { select: { nom: true } },
        villes_ci: { select: { nom: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async createEntrepot(userId: string, dto: CreateEntrepotDto) {
    const entrepot = await this.prisma.entrepots.create({
      data: {
        owner_id: userId,
        nom: dto.nom,
        region_id: dto.region_id,
        ville_id: dto.ville_id,
        adresse: dto.adresse,
        capacite_kg: dto.capacite_kg,
        is_refrigere: dto.is_refrigere ?? false,
      },
    });
    return { message: 'Entrepôt créé avec succès.', id: entrepot.id };
  }

  async updateEntrepot(userId: string, id: string, dto: UpdateEntrepotDto) {
    const entrepot = await this.prisma.entrepots.findFirst({
      where: { id, owner_id: userId },
    });
    if (!entrepot) throw new NotFoundException('Entrepôt introuvable.');

    await this.prisma.entrepots.update({
      where: { id },
      data: {
        ...(dto.nom !== undefined && { nom: dto.nom }),
        ...(dto.capacite_kg !== undefined && { capacite_kg: dto.capacite_kg }),
        ...(dto.is_refrigere !== undefined && { is_refrigere: dto.is_refrigere }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });
    return { message: 'Entrepôt modifié.' };
  }

  async deleteEntrepot(userId: string, id: string) {
    const entrepot = await this.prisma.entrepots.findFirst({
      where: { id, owner_id: userId },
    });
    if (!entrepot) throw new NotFoundException('Entrepôt introuvable.');
    await this.prisma.entrepots.delete({ where: { id } });
    return { message: 'Entrepôt supprimé.' };
  }

  // ===================================================================
  //  LOTS DANS UN ENTREPÔT
  //  ---------------------------------------------------------------------
  //  Liste tous les lots stockés dans un entrepôt donné via la table de
  //  jonction `stock`. Vérifie au préalable l'ownership de l'entrepôt :
  //   • Owner direct (entrepots.owner_id === userId), OU
  //   • Coopérative dont le user est président (cooperative_profiles.user_id),
  //     auquel cas tout entrepôt dont l'owner_id pointe sur le user_id
  //     de cette coop OU dont les lots stockés appartiennent à la coop
  //     sont acceptés.
  // ===================================================================
  async listLotsByEntrepot(
    userId: string,
    role: string,
    coopId: string | null,
    entrepotId: string,
  ) {
    const entrepot = await this.prisma.entrepots.findUnique({
      where: { id: entrepotId },
      select: { id: true, owner_id: true, nom: true },
    });
    if (!entrepot) throw new NotFoundException('Entrepôt introuvable.');

    // Ownership : direct OU (rôle COOPERATIVE + entrepôt appartient à
    // un user lié à la coop, c'est-à-dire l'utilisateur de la coop est
    // l'owner). On accepte aussi que la coop voie un entrepôt si son
    // owner_id coïncide avec le user de la coop (cas standard) — ou si
    // au moins un lot stocké est de cette coop (fallback métier).
    let ownsEntrepot = entrepot.owner_id === userId;
    if (!ownsEntrepot && role === 'COOPERATIVE' && coopId) {
      // Entrepôt directement détenu par le compte coop (owner = userId)
      // déjà géré au-dessus. Ici on couvre le cas où la coop a stocké
      // des lots dans un entrepôt rattaché à un de ses membres : on
      // autorise la lecture des SEULS lots de la coop dans cet entrepôt.
      const coopLotsInEntrepot = await this.prisma.stock.findFirst({
        where: {
          entrepot_id: entrepotId,
          lots: { cooperative_id: coopId },
        },
        select: { id: true },
      });
      ownsEntrepot = !!coopLotsInEntrepot;
    }

    if (!ownsEntrepot) {
      throw new ForbiddenException(
        "Vous n'avez pas accès à cet entrepôt.",
      );
    }

    const rows = await this.prisma.stock.findMany({
      where: {
        entrepot_id: entrepotId,
        lot_id: { not: null },
      },
      include: {
        lots: {
          include: {
            produits_agricoles: { select: { id: true, nom: true } },
            users: { select: { id: true, full_name: true } },
            cooperative_profiles: { select: { id: true, nom: true } },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return rows.map((row) => ({
      stock_id: row.id,
      quantite_kg: row.quantite_kg,
      date_entree: row.date_entree,
      date_sortie_prev: row.date_sortie_prev,
      notes: row.notes,
      lot: row.lots,
    }));
  }

  // ===================================================================
  //  LOTS
  // ===================================================================

  /**
   * Liste les lots appartenant à l'utilisateur (farmer) ou à sa
   * coopérative. Le `coopId` provient du JWT (peut être null si le
   * user n'est pas rattaché à une coop).
   */
  async getMesLots(userId: string, coopId: string | null) {
    return this.prisma.lots.findMany({
      where: {
        OR: [
          { farmer_id: userId },
          ...(coopId ? [{ cooperative_id: coopId }] : []),
        ],
      },
      include: {
        produits_agricoles: { select: { nom: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Crée un lot. Le rôle de l'utilisateur DOIT correspondre au type
   * du lot : un FARMER ne peut pas créer de lot COOPERATIVE, et
   * inversement. Le cooperative_id vient du JWT.
   */
  async createLot(
    userId: string,
    role: string,
    coopId: string | null,
    dto: CreateLotDto,
  ) {
    if (dto.type === LotType.INDIVIDUAL && role !== 'FARMER') {
      throw new ForbiddenException('Seul un FARMER peut créer un lot INDIVIDUAL.');
    }
    if (dto.type === LotType.COOPERATIVE) {
      if (role !== 'COOPERATIVE') {
        throw new ForbiddenException(
          'Seul une COOPERATIVE peut créer un lot COOPERATIVE.',
        );
      }
      if (!coopId) {
        throw new BadRequestException('Coopérative non identifiée dans le JWT.');
      }
    }

    const lot = await this.prisma.lots.create({
      data: {
        lot_code: dto.lot_code,
        type: dto.type,
        farmer_id: dto.type === LotType.INDIVIDUAL ? userId : null,
        cooperative_id: dto.type === LotType.COOPERATIVE ? coopId : null,
        produit_id: dto.produit_id,
        quantite_kg: dto.quantite_kg,
        qualite: dto.qualite,
        date_recolte: dto.date_recolte ? new Date(dto.date_recolte) : undefined,
      },
    });
    return { message: 'Lot enregistré avec succès.', id: lot.id };
  }

  async updateLot(
    userId: string,
    coopId: string | null,
    id: string,
    dto: UpdateLotDto,
  ) {
    const lot = await this.prisma.lots.findFirst({
      where: {
        id,
        OR: [
          { farmer_id: userId },
          ...(coopId ? [{ cooperative_id: coopId }] : []),
        ],
      },
    });
    if (!lot) throw new NotFoundException('Lot introuvable.');

    await this.prisma.lots.update({
      where: { id },
      data: {
        ...(dto.quantite_kg !== undefined && { quantite_kg: dto.quantite_kg }),
        ...(dto.qualite !== undefined && { qualite: dto.qualite }),
      },
    });
    return { message: 'Lot modifié.' };
  }

  async deleteLot(userId: string, coopId: string | null, id: string) {
    const lot = await this.prisma.lots.findFirst({
      where: {
        id,
        OR: [
          { farmer_id: userId },
          ...(coopId ? [{ cooperative_id: coopId }] : []),
        ],
      },
    });
    if (!lot) throw new NotFoundException('Lot introuvable.');
    await this.prisma.lots.delete({ where: { id } });
    return { message: 'Lot supprimé.' };
  }
}
