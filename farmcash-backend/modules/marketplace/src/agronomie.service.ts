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
  ConflictException,
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

  /**
   * Crée une parcelle pour le producteur.
   *
   * Anti-doublons : si le user a déjà créé une parcelle avec le même
   * `nom` (case-insensitive) dans les 60 dernières secondes, on refuse
   * avec un `409 Conflict`. Cible le cas concret d'un double-tap UI ou
   * d'un retry réseau client qui réessaie un POST déjà commit côté DB.
   * Deux parcelles homonymes légitimes (créées à des jours différents)
   * restent autorisées — c'est une protection ANTI-RETRY, pas une
   * contrainte d'unicité métier.
   *
   * Retour : l'ENTITÉ Parcelle complète (et non plus `{ message, id }`)
   * pour que le client puisse parser directement sans round-trip GET.
   * Le client mobile reposait sur ce contrat — l'ancienne shape causait
   * un crash de `Parcelle.fromJson` et faisait croire à un échec, ce
   * qui poussait le user à re-cliquer et créait un vrai doublon en DB.
   */
  async createParcelle(userId: string, dto: CreateParcelleDto) {
    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    const recent = await this.prisma.parcelle.findFirst({
      where: {
        user_id: userId,
        nom: { equals: dto.nom, mode: 'insensitive' },
        created_at: { gte: sixtySecondsAgo },
      },
      select: { id: true },
    });
    if (recent) {
      throw new ConflictException(
        'Une parcelle avec ce nom vient déjà d\'être créée. Vérifie dans "Mes parcelles".',
      );
    }

    // PostGIS : on insère via $queryRaw quand un centroid est fourni
    // pour stocker le Point(lng, lat). Sinon création « classique »
    // sans géoloc — utile pour les parcelles enregistrées hors GPS.
    let createdId: string;
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
      const id = rows[0]?.id;
      if (!id) {
        throw new BadRequestException('Création de parcelle échouée.');
      }
      createdId = id;
    } else {
      const parcelle = await this.prisma.parcelle.create({
        data: {
          user_id: userId,
          nom: dto.nom,
          superficie_ha: dto.superficie_ha,
          ...(dto.produit_id && { produit_id: dto.produit_id }),
        },
      });
      createdId = parcelle.id;
    }

    // SELECT final → on renvoie l'entité Prisma standard, identique en
    // shape à ce que `getMesParcelles` retourne. Le mobile peut donc
    // utiliser le même parser `Parcelle.fromJson` que pour la liste.
    const created = await this.prisma.parcelle.findUnique({
      where: { id: createdId },
    });
    if (!created) {
      throw new BadRequestException('Parcelle créée mais introuvable.');
    }
    return created;
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
