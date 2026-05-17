// =====================================================================
//  SERVICE : MarketplaceService
//  ---------------------------------------------------------------------
//  Logique métier des annonces (vente + achat) et des publications
//  agrégées de coopératives.
//
//  Tables manipulées :
//    • annonces_vente             — annonces individuelles (FARMER)
//    • annonces_achat             — demandes d'achat       (BUYER)
//    • publications_stock_coop    — stocks agrégés         (COOPERATIVE)
//    • produits_agricoles         — catalogue (lecture seule)
//
//  Distinctions importantes :
//    • Pour publier sur `annonces_vente`, le user DOIT avoir le rôle
//      FARMER → on stocke son user_id dans farmer_id.
//    • Une COOPERATIVE qui veut vendre passe par
//      `publications_stock_coop` avec cooperative_id = id du profil
//      coopérative (extrait du JWT — pas du user_id).
// =====================================================================

import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, product_status } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { CooperativesService } from '@farmcash/cooperatives';
import {
  CreateAnnonceAchatDto,
  CreateAnnonceVenteDto,
  ListerAnnoncesAchatQueryDto,
  ListerAnnoncesVenteQueryDto,
  UpdateAnnonceAchatDto,
  UpdateAnnonceVenteDto,
} from './dto/annonces.dto';

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => CooperativesService))
    private readonly cooperativesService: CooperativesService,
  ) {}

  // ===================================================================
  //  CATALOGUE
  // ===================================================================

  /**
   * Liste les produits agricoles actifs du catalogue.
   * Triés par `sort_order` pour permettre un ordre manuel côté admin.
   */
  async getProduitsAgricoles() {
    return this.prisma.produits_agricoles.findMany({
      where: { is_active: true },
      orderBy: [{ sort_order: 'asc' }, { nom: 'asc' }],
    });
  }

  /**
   * Liste les catégories de cultures actives, avec leurs sous-catégories.
   * Utilisé pour les filtres côté front (cf. CategoriesController).
   */
  async getCategories() {
    return this.prisma.categories_cultures.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
      include: {
        sous_categories: {
          orderBy: { sort_order: 'asc' },
        },
      },
    });
  }

  /**
   * Référentiel des villes CI (~40 entrées). On joint la région pour
   * éviter au client un second appel quand il a besoin du nom de région.
   */
  async getVilles() {
    return this.prisma.villes_ci.findMany({
      orderBy: { nom: 'asc' },
      select: {
        id: true,
        nom: true,
        region_id: true,
        regions_ci: { select: { nom: true } },
      },
    });
  }

  // ===================================================================
  //  ANNONCES DE VENTE
  // ===================================================================

  /**
   * Liste paginée des annonces ACTIVES. Filtres optionnels :
   * produit, région, qualité. Retourne aussi les méta de pagination.
   */
  async getAnnoncesVente(query: ListerAnnoncesVenteQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    // Exclut explicitement les annonces "embarquées" dans un workflow
    // coopérative (PENDING / VALIDATED / INCLUDED / REJECTED) — ces
    // annonces ne doivent jamais apparaître sur le marketplace public,
    // car la publication coop est l'objet vendable côté marché.
    const where: Prisma.annonces_venteWhereInput = {
      status: product_status.ACTIVE,
      coop_status: null,
      ...(query.produit_id && { produit_id: query.produit_id }),
      ...(query.region_id && { region_id: query.region_id }),
      ...(query.qualite && { qualite: query.qualite }),
    };

    const [annonces, total] = await Promise.all([
      this.prisma.annonces_vente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          produits_agricoles: { select: { nom: true, unite_mesure: true } },
          users: { select: { full_name: true, rating: true } },
          regions_ci: { select: { nom: true } },
          medias: { select: { url: true, thumbnail_url: true }, take: 5 },
        },
      }),
      this.prisma.annonces_vente.count({ where }),
    ]);

    return {
      data: annonces,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Détail d'une annonce par ID. Incrémente `views_count` au passage
   * (sauf si le visiteur est le propriétaire de l'annonce — pas de
   * gonflage artificiel).
   */
  async getAnnonceVenteById(id: string, viewerId?: string) {
    const annonce = await this.prisma.annonces_vente.findUnique({
      where: { id },
      include: {
        produits_agricoles: true,
        users: { select: { id: true, full_name: true, rating: true, photo_url: true } },
        regions_ci: { select: { nom: true } },
        villes_ci: { select: { nom: true } },
        medias: true,
        annonce_vente_traitements: {
          include: {
            produits_traitement: {
              select: {
                id: true,
                nom: true,
                type: true,
                cultures_cibles: true,
                maladies_cibles: true,
                delai_carence_j: true,
              },
            },
          },
          orderBy: { date_application: 'desc' },
        },
      },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable.');

    if (viewerId && viewerId !== annonce.farmer_id) {
      await this.prisma.annonces_vente.update({
        where: { id },
        data: { views_count: { increment: 1 } },
      });
    }

    return annonce;
  }

  /**
   * Crée une annonce de vente. Réservé aux FARMER (les COOP passent
   * par createPublicationCoop). On insère via $queryRaw pour pouvoir
   * poser le point PostGIS.
   *
   * @param userId Doit être le user_id du fermier (auth: role === FARMER).
   */
  async createAnnonceVente(userId: string, role: string, dto: CreateAnnonceVenteDto) {
    if (role !== 'FARMER') {
      throw new ForbiddenException(
        'Seuls les FARMER publient via /annonces/vente. Les COOPERATIVE utilisent /publications/coop.',
      );
    }

    const { lng, lat } = dto.coordinates;

    // `quantite_min_kg` optionnelle côté DTO : si absente, on prend la
    // quantité totale (= l'acheteur prend tout d'un coup, le cas courant
    // chez le petit producteur). Le ?? 0 final est un garde-fou TS.
    const quantiteMin = dto.quantite_min_kg ?? dto.quantite_kg;

    const result = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO annonces_vente (
        farmer_id, produit_id, titre, description,
        quantite_kg, prix_par_kg, quantite_min_kg, qualite,
        region_id, ville_id, location, status,
        certifications, disponible_jusqu
      ) VALUES (
        ${userId}::uuid,
        ${dto.produit_id}::uuid,
        ${dto.titre},
        ${dto.description ?? null},
        ${dto.quantite_kg},
        ${dto.prix_par_kg},
        ${quantiteMin},
        ${dto.qualite}::product_quality,
        ${dto.region_id ?? null}::uuid,
        ${dto.ville_id ?? null}::uuid,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326),
        ${product_status.ACTIVE}::product_status,
        ${dto.certifications ?? []}::text[],
        ${dto.disponible_jusqu ? new Date(dto.disponible_jusqu) : null}
      ) RETURNING id;
    `;
    const annonceId = result[0]?.id;

    // Insère les traitements appliqués (traçabilité / certif BIO).
    // Chaque entrée peut fournir produit_traitement_id OU produit_traitement_nom.
    // On résout le nom (recherche insensible casse, ILIKE) si UUID absent.
    if (annonceId && dto.traitements?.length) {
      const resolved: Array<{
        id: string;
        dosage_utilise?: string;
        date_application?: Date | null;
        delai_carence_respecte?: boolean;
        notes?: string;
      }> = [];
      for (const t of dto.traitements) {
        let pid = t.produit_traitement_id;
        if (!pid) {
          if (!t.produit_traitement_nom) {
            await this.prisma.annonces_vente.delete({ where: { id: annonceId } });
            throw new BadRequestException(
              'Chaque traitement doit avoir un produit_traitement_id OU un produit_traitement_nom.',
            );
          }
          const match = await this.prisma.produits_traitement.findFirst({
            where: { nom: { contains: t.produit_traitement_nom, mode: 'insensitive' } },
            select: { id: true, nom: true },
          });
          if (!match) {
            await this.prisma.annonces_vente.delete({ where: { id: annonceId } });
            throw new BadRequestException(
              `Traitement "${t.produit_traitement_nom}" introuvable dans le catalogue.`,
            );
          }
          pid = match.id;
        } else {
          // Vérification UUID
          const exists = await this.prisma.produits_traitement.findUnique({
            where: { id: pid },
            select: { id: true },
          });
          if (!exists) {
            await this.prisma.annonces_vente.delete({ where: { id: annonceId } });
            throw new BadRequestException(
              `Traitement ${pid} introuvable dans le catalogue.`,
            );
          }
        }
        resolved.push({
          id: pid,
          dosage_utilise: t.dosage_utilise,
          date_application: t.date_application ? new Date(t.date_application) : null,
          delai_carence_respecte: t.delai_carence_respecte,
          notes: t.notes,
        });
      }
      await this.prisma.annonce_vente_traitements.createMany({
        data: resolved.map((r) => ({
          annonce_vente_id: annonceId,
          produit_traitement_id: r.id,
          dosage_utilise: r.dosage_utilise,
          date_application: r.date_application,
          delai_carence_respecte: r.delai_carence_respecte,
          notes: r.notes,
        })),
        skipDuplicates: true,
      });
    }

    // Délègue au module Cooperatives le workflow d'assignation (membership
    // check + lock du statut). Si la coop refuse (pas membre), on rollback
    // l'annonce pour ne pas laisser de demi-création.
    if (annonceId && dto.assigned_to_cooperative_id) {
      try {
        await this.cooperativesService.attachAnnonceToCoop(
          annonceId,
          dto.assigned_to_cooperative_id,
          userId,
        );
      } catch (e) {
        await this.prisma.annonces_vente.delete({ where: { id: annonceId } });
        throw e;
      }
    }

    return {
      message: dto.assigned_to_cooperative_id
        ? 'Annonce confiée à votre coopérative (en attente de validation).'
        : 'Annonce créée avec succès.',
      annonce_id: annonceId,
      coop_status: dto.assigned_to_cooperative_id ? 'PENDING' : null,
      traitements_declares: dto.traitements?.length ?? 0,
    };
  }

  /**
   * Modifie une annonce de vente. Vérifie d'abord que l'annonce
   * appartient bien à l'utilisateur (ownership check).
   */
  async updateAnnonceVente(userId: string, id: string, dto: UpdateAnnonceVenteDto) {
    const annonce = await this.prisma.annonces_vente.findFirst({
      where: { id, farmer_id: userId },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable ou non autorisée.');

    // Une fois VALIDATED ou INCLUDED par la coop, l'annonce est verrouillée.
    // Seul un statut PENDING (en attente de pesée) ou REJECTED (libéré) ou
    // null (annonce libre, marketplace public) reste modifiable.
    if (annonce.coop_status === 'VALIDATED' || annonce.coop_status === 'INCLUDED') {
      throw new ForbiddenException(
        'Annonce verrouillée par votre coopérative — modification impossible.',
      );
    }

    await this.prisma.annonces_vente.update({
      where: { id },
      data: {
        ...(dto.titre !== undefined && { titre: dto.titre }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.quantite_kg !== undefined && { quantite_kg: dto.quantite_kg }),
        ...(dto.prix_par_kg !== undefined && { prix_par_kg: dto.prix_par_kg }),
        ...(dto.quantite_min_kg !== undefined && {
          quantite_min_kg: dto.quantite_min_kg,
        }),
        ...(dto.qualite !== undefined && { qualite: dto.qualite }),
        ...(dto.status !== undefined && { status: dto.status as product_status }),
      },
    });
    return { message: 'Annonce de vente modifiée.' };
  }

  async deleteAnnonceVente(userId: string, id: string) {
    const annonce = await this.prisma.annonces_vente.findFirst({
      where: { id, farmer_id: userId },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable ou non autorisée.');
    if (annonce.coop_status === 'VALIDATED' || annonce.coop_status === 'INCLUDED') {
      throw new ForbiddenException(
        'Annonce verrouillée par votre coopérative — suppression impossible.',
      );
    }
    await this.prisma.annonces_vente.delete({ where: { id } });
    return { message: 'Annonce de vente supprimée.' };
  }

  // ===================================================================
  //  ANNONCES D'ACHAT
  // ===================================================================

  /**
   * Liste paginée des demandes d'achat ACTIVES. Permet aux FARMER et
   * COOPERATIVE de découvrir les besoins exprimés par les BUYER.
   */
  async getAnnoncesAchat(query: ListerAnnoncesAchatQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    // Seules les offres PUBLIC apparaissent sur le marketplace.
    // Les ALL_COOPERATIVES et SPECIFIC_COOPERATIVE sont visibles via
    // /coop/annonces-achat/incoming.
    const where: Prisma.annonces_achatWhereInput = {
      is_active: true,
      target_audience: 'PUBLIC',
      ...(query.produit_id && { produit_id: query.produit_id }),
      ...(query.region_id && { region_id: query.region_id }),
      ...(query.qualite && { qualite: query.qualite }),
    };

    const [data, total] = await Promise.all([
      this.prisma.annonces_achat.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          produits_agricoles: { select: { nom: true, unite_mesure: true } },
          users: { select: { full_name: true, rating: true } },
          regions_ci: { select: { nom: true } },
        },
      }),
      this.prisma.annonces_achat.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Détail d'une demande d'achat. 404 si elle n'existe pas.
   */
  async getAnnonceAchatById(id: string) {
    const annonce = await this.prisma.annonces_achat.findUnique({
      where: { id },
      include: {
        produits_agricoles: true,
        users: { select: { id: true, full_name: true, rating: true, photo_url: true } },
        regions_ci: { select: { nom: true } },
        villes_ci: { select: { nom: true } },
      },
    });
    if (!annonce) throw new NotFoundException("Demande d'achat introuvable.");
    return annonce;
  }

  async createAnnonceAchat(userId: string, dto: CreateAnnonceAchatDto) {
    // Détermine target_audience selon les inputs :
    //  • explicite via dto.target_audience
    //  • sinon, déduit : target_cooperative_id présent → SPECIFIC_COOPERATIVE
    //                  : sinon → PUBLIC
    let audience: 'PUBLIC' | 'ALL_COOPERATIVES' | 'SPECIFIC_COOPERATIVE' =
      dto.target_audience ??
      (dto.target_cooperative_id ? 'SPECIFIC_COOPERATIVE' : 'PUBLIC');

    // Cohérence : SPECIFIC_COOPERATIVE exige target_cooperative_id, et
    // la coop doit exister. PUBLIC / ALL_COOPERATIVES ignorent ce champ.
    if (audience === 'SPECIFIC_COOPERATIVE') {
      if (!dto.target_cooperative_id) {
        throw new BadRequestException(
          'target_cooperative_id requis pour SPECIFIC_COOPERATIVE.',
        );
      }
      const coop = await this.prisma.cooperative_profiles.findUnique({
        where: { id: dto.target_cooperative_id },
        select: { id: true },
      });
      if (!coop) throw new NotFoundException('Coopérative ciblée introuvable.');
    }

    const annonce = await this.prisma.annonces_achat.create({
      data: {
        buyer_id: userId,
        produit_id: dto.produit_id,
        quantite_kg: dto.quantite_kg,
        prix_max_kg: dto.prix_max_kg,
        qualite: dto.qualite,
        region_id: dto.region_id,
        rayon_km: dto.rayon_km ?? 100,
        target_audience: audience as any,
        target_cooperative_id:
          audience === 'SPECIFIC_COOPERATIVE' ? dto.target_cooperative_id : null,
        is_active: true,
      },
    });

    const messages: Record<typeof audience, string> = {
      PUBLIC: "Demande d'achat publiée.",
      ALL_COOPERATIVES: "Demande d'achat envoyée à toutes les coopératives.",
      SPECIFIC_COOPERATIVE: "Demande d'achat envoyée à la coopérative ciblée.",
    };
    return {
      message: messages[audience],
      annonce_id: annonce.id,
      target_audience: audience,
    };
  }

  async updateAnnonceAchat(userId: string, id: string, dto: UpdateAnnonceAchatDto) {
    const annonce = await this.prisma.annonces_achat.findFirst({
      where: { id, buyer_id: userId },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable.');
    await this.prisma.annonces_achat.update({
      where: { id },
      data: {
        ...(dto.quantite_kg !== undefined && { quantite_kg: dto.quantite_kg }),
        ...(dto.prix_max_kg !== undefined && { prix_max_kg: dto.prix_max_kg }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });
    return { message: "Annonce d'achat modifiée." };
  }

  async deleteAnnonceAchat(userId: string, id: string) {
    const annonce = await this.prisma.annonces_achat.findFirst({
      where: { id, buyer_id: userId },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable.');
    await this.prisma.annonces_achat.delete({ where: { id } });
    return { message: "Annonce d'achat supprimée." };
  }

  // ===================================================================
  //  PUBLICATIONS COOPÉRATIVES → migrées dans le module Cooperatives.
  //  Voir : modules/cooperatives/src/cooperatives.service.ts
  //  Routes :
  //   • GET    /api/cooperatives/publications/list    (public)
  //   • GET    /api/cooperatives/publications/:id     (public)
  //   • POST   /api/coop/publications                 (COOP)
  //   • PUT    /api/coop/publications/:id             (COOP)
  //   • DELETE /api/coop/publications/:id             (COOP)
  // ===================================================================
}
