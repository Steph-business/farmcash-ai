// =====================================================================
//  SERVICE : AgronomieService
//  ---------------------------------------------------------------------
//  Gère les parcelles agricoles (`parcelle`) et les cultures déclarées
//  par les producteurs (`user_cultures`).
//
//  Règle métier importante :
//   Plusieurs cultures peuvent être plantées sur une même parcelle,
//   mais la somme de leurs superficies ne doit pas dépasser la
//   superficie de la parcelle.
// =====================================================================

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import {
  AddCultureDto,
  CreateParcelleDto,
  UpdateParcelleDto,
} from './dto/agronomie.dto';

@Injectable()
export class AgronomieService {
  constructor(private readonly prisma: PrismaService) {}

  // ===================================================================
  //  PARCELLES
  // ===================================================================

  async getMesParcelles(userId: string) {
    return this.prisma.parcelle.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
  }

  async createParcelle(userId: string, dto: CreateParcelleDto) {
    // PostGIS : on insère via $executeRaw quand un centroid est fourni
    // pour stocker le Point(lng, lat). Sinon création « classique »
    // sans géoloc — utile pour les parcelles enregistrées hors GPS.
    if (dto.centroid) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO parcelle (user_id, nom, superficie_ha, produit_id, centroid)
        VALUES (
          ${userId}::uuid,
          ${dto.nom},
          ${dto.superficie_ha},
          ${dto.produit_id ?? null}::uuid,
          ST_SetSRID(ST_MakePoint(${dto.centroid.lng}, ${dto.centroid.lat}), 4326)
        )
        RETURNING id;
      `;
      return { message: 'Parcelle créée avec succès.', id: rows[0]?.id };
    }
    const parcelle = await this.prisma.parcelle.create({
      data: {
        user_id: userId,
        nom: dto.nom,
        superficie_ha: dto.superficie_ha,
        ...(dto.produit_id && { produit_id: dto.produit_id }),
      },
    });
    return { message: 'Parcelle créée avec succès.', id: parcelle.id };
  }

  async updateParcelle(userId: string, id: string, dto: UpdateParcelleDto) {
    const parcelle = await this.prisma.parcelle.findFirst({
      where: { id, user_id: userId },
    });
    if (!parcelle) throw new NotFoundException('Parcelle introuvable.');

    await this.prisma.parcelle.update({
      where: { id },
      data: {
        ...(dto.nom !== undefined && { nom: dto.nom }),
        ...(dto.superficie_ha !== undefined && {
          superficie_ha: dto.superficie_ha,
        }),
        ...(dto.produit_id !== undefined && { produit_id: dto.produit_id }),
      },
    });
    return { message: 'Parcelle modifiée.' };
  }

  async deleteParcelle(userId: string, id: string) {
    const parcelle = await this.prisma.parcelle.findFirst({
      where: { id, user_id: userId },
    });
    if (!parcelle) throw new NotFoundException('Parcelle introuvable.');
    await this.prisma.parcelle.delete({ where: { id } });
    return { message: 'Parcelle supprimée.' };
  }

  // ===================================================================
  //  CULTURES (user_cultures)
  // ===================================================================

  /**
   * Liste les cultures du producteur, éventuellement filtrées sur une
   * parcelle précise. Le filtre `parcelleId` est utilisé par le mobile
   * dans le formulaire « Publier une annonce » pour proposer SEULEMENT
   * les cultures du champ que le producteur a sélectionné (traçabilité).
   */
  async getMesCultures(userId: string, parcelleId?: string) {
    return this.prisma.user_cultures.findMany({
      where: {
        user_id: userId,
        ...(parcelleId && { parcelle_id: parcelleId }),
      },
      include: { produits_agricoles: { select: { nom: true } } },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Ajoute une culture sur une parcelle.
   *
   * Vérifications :
   *   1. La parcelle existe et appartient à l'utilisateur.
   *   2. La somme des superficies des cultures de CETTE parcelle (incluant
   *      la nouvelle) ne dépasse pas la superficie de la parcelle.
   */
  async addCultureToParcelle(userId: string, dto: AddCultureDto) {
    const parcelle = await this.prisma.parcelle.findFirst({
      where: { id: dto.parcelle_id, user_id: userId },
    });
    if (!parcelle) throw new NotFoundException('Parcelle introuvable.');

    const surfaceParcelle = parcelle.superficie_ha?.toNumber() ?? 0;
    const culturesExistantes = await this.prisma.user_cultures.findMany({
      where: { parcelle_id: dto.parcelle_id },
      select: { superficie_ha: true },
    });
    const dejaUtilisee = culturesExistantes.reduce(
      (s, c) => s + (c.superficie_ha?.toNumber() ?? 0),
      0,
    );
    if (dejaUtilisee + dto.superficie_ha > surfaceParcelle) {
      throw new BadRequestException(
        `Superficie cumulée (${(dejaUtilisee + dto.superficie_ha).toFixed(2)}ha) > parcelle (${surfaceParcelle}ha).`,
      );
    }

    const culture = await this.prisma.user_cultures.create({
      data: {
        user_id: userId,
        parcelle_id: dto.parcelle_id,
        produit_id: dto.produit_id,
        superficie_ha: dto.superficie_ha,
      },
    });
    return { message: 'Culture ajoutée à la parcelle.', id: culture.id };
  }

  async deleteCulture(userId: string, id: string) {
    const culture = await this.prisma.user_cultures.findFirst({
      where: { id, user_id: userId },
    });
    if (!culture) throw new NotFoundException('Culture introuvable.');
    await this.prisma.user_cultures.delete({ where: { id } });
    return { message: 'Culture supprimée.' };
  }
}
