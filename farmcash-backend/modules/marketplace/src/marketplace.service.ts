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
  ConflictException,
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
      // Filtre par farmer — utilisé par la page "Profil vendeur" (acheteur)
      // et par "Mes publications" (producteur) pour ne lister que ses
      // propres annonces.
      ...(query.farmer_id && { farmer_id: query.farmer_id }),
    };

    const [annonces, total] = await Promise.all([
      this.prisma.annonces_vente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          produits_agricoles: { select: { nom: true, unite_mesure: true } },
          // Inclut `reliability_score` pour permettre au mobile d'afficher
          // la note de fiabilité du farmer directement sur les cards
          // marketplace, sans avoir à appeler GET /users/:id en plus.
          users: {
            select: {
              id: true,
              full_name: true,
              rating: true,
              photo_url: true,
              reliability_score: true,
            },
          },
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
        users: { select: { id: true, full_name: true, rating: true, photo_url: true, reliability_score: true } },
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
   * Crée une annonce de vente. Deux cas d'usage :
   *
   *  • FARMER classique → publie pour lui-même. `act_as_farmer_id` doit
   *    être absent ; sinon BadRequestException.
   *
   *  • COOPERATIVE publiant POUR un farmer géré → doit fournir
   *    `act_as_farmer_id`. Le service vérifie que ce farmer est bien
   *    `managed_by_coop_id = <user_id de la coop>` (cf.
   *    cooperativesService.assertFarmerManagedByCoop). L'annonce est
   *    créée avec `farmer_id = act_as_farmer_id` (le farmer reste le
   *    producteur du point de vue traçabilité ; la coop intervient
   *    uniquement comme tutrice / publicatrice).
   *
   *  Les COOP qui veulent vendre leur PROPRE stock continuent d'utiliser
   *  /coop/publications (createPublicationCoop) — ce n'est pas le même
   *  flow métier.
   *
   * @param userId   Le user authentifié (FARMER ou COOPERATIVE)
   * @param role     Rôle JWT (FARMER | COOPERATIVE | …)
   * @param dto      Payload de l'annonce
   */
  async createAnnonceVente(userId: string, role: string, dto: CreateAnnonceVenteDto) {
    // --------------- 1. Détermine l'identité du « farmer publiant »
    // C'est le farmer_id réel qu'on écrira en DB (traçabilité). Par
    // défaut = userId. Si COOP avec act_as_farmer_id valide → on bascule.
    let farmerId = userId;

    if (dto.act_as_farmer_id) {
      // Seuls les COOPERATIVE peuvent publier au nom d'un autre.
      if (role !== 'COOPERATIVE') {
        throw new BadRequestException(
          "Seul un compte COOPERATIVE peut publier au nom d'un producteur géré (act_as_farmer_id).",
        );
      }
      // Vérifie que la coop a bien le droit de publier pour ce farmer.
      // Cette méthode lève une ForbiddenException si KO.
      await this.cooperativesService.assertFarmerManagedByCoop(
        userId,
        dto.act_as_farmer_id,
      );
      farmerId = dto.act_as_farmer_id;
    } else if (role !== 'FARMER') {
      // Un COOPERATIVE sans act_as_farmer_id sur cette route = mauvais
      // flow (sa propre coop publie via /coop/publications, pas ici).
      throw new ForbiddenException(
        'Seuls les FARMER publient via /annonces/vente. Les COOPERATIVE utilisent /publications/coop ou doivent fournir act_as_farmer_id pour un membre géré.',
      );
    }

    // --------------- 2. Anti-retry idempotent
    // Si le même FARMER (ou la même coop pour le même farmer) a publié
    // une annonce avec exactement (titre, produit, quantité, prix) dans
    // les 60 dernières secondes, on refuse avec un 409. Couvre le cas
    // concret d'un double-tap UI ou d'un retry réseau client qui
    // réessaie un POST déjà commit. Deux annonces identiques créées à
    // des jours différents restent autorisées (le producteur peut
    // légitimement re-publier la même récolte plus tard).
    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    const recent = await this.prisma.annonces_vente.findFirst({
      where: {
        farmer_id: farmerId,
        produit_id: dto.produit_id,
        titre: dto.titre,
        quantite_kg: dto.quantite_kg,
        prix_par_kg: dto.prix_par_kg,
        created_at: { gte: sixtySecondsAgo },
      },
      select: { id: true },
    });
    if (recent) {
      throw new ConflictException(
        'Cette annonce vient déjà d\'être publiée. Vérifie dans "Mes publications".',
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
        certifications, disponible_jusqu, date_recolte
      ) VALUES (
        ${farmerId}::uuid,
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
        ${dto.disponible_jusqu ? new Date(dto.disponible_jusqu) : null},
        ${dto.date_recolte ? new Date(dto.date_recolte) : null}
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
    // l'annonce pour ne pas laisser de demi-création. On passe `farmerId`
    // (et non userId) : pour les COOP publiant au nom d'un membre géré,
    // c'est bien le farmer cible dont on doit vérifier l'appartenance.
    if (annonceId && dto.assigned_to_cooperative_id) {
      try {
        await this.cooperativesService.attachAnnonceToCoop(
          annonceId,
          dto.assigned_to_cooperative_id,
          farmerId,
        );
      } catch (e) {
        await this.prisma.annonces_vente.delete({ where: { id: annonceId } });
        throw e;
      }
    }

    // On renvoie désormais l'ENTITÉ AnnonceVente complète (avec les
    // jointures standards utilisées par `getAnnonceVente`) plutôt qu'un
    // simple `{ message, annonce_id }`. Raison : le client mobile parse
    // la réponse via `AnnonceVente.fromJson` qui exige des champs
    // required (`id`, `farmer_id`, `produit_id`...). Renvoyer un objet
    // minimal faisait crasher le parser freezed côté mobile avec un
    // `CheckedFromJsonException` et faisait croire à un échec alors que
    // l'annonce était bien créée en DB → user qui re-clique → doublons.
    //
    // Les métadonnées de workflow (`message`, `coop_status`,
    // `traitements_declares`) sont conservées comme champs additionnels
    // sur la même réponse — le parser mobile ignore les champs inconnus.
    if (!annonceId) {
      throw new BadRequestException('Création d\'annonce échouée.');
    }
    const created = await this.prisma.annonces_vente.findUnique({
      where: { id: annonceId },
      include: {
        produits_agricoles: { select: { nom: true, unite_mesure: true } },
        users: {
          select: { id: true, full_name: true, rating: true, photo_url: true, reliability_score: true },
        },
        regions_ci: { select: { nom: true } },
        villes_ci: { select: { nom: true } },
        medias: { select: { url: true, thumbnail_url: true }, take: 3 },
      },
    });
    if (!created) {
      throw new BadRequestException('Annonce créée mais introuvable.');
    }
    return {
      ...created,
      message: dto.assigned_to_cooperative_id
        ? 'Annonce confiée à votre coopérative (en attente de validation).'
        : 'Annonce créée avec succès.',
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

    // Dès qu'une annonce est confiée à une coopérative (coop_status non
    // null, sauf REJECTED qui libère l'annonce), le farmer ne peut plus
    // la modifier — sinon il pourrait altérer la quantité/prix une fois
    // que la coop a accepté de la prendre en charge.
    //   • PENDING   : la coop n'a pas encore décidé → lock pour éviter
    //                 que le farmer baisse la qty pendant la validation.
    //   • VALIDATED : la coop a accepté, l'annonce est sous sa responsabilité.
    //   • INCLUDED  : l'annonce est dans une publication coop agrégée.
    //   • REJECTED  : la coop a refusé → le farmer reprend la main.
    //   • null      : annonce libre (marketplace public).
    if (
      annonce.coop_status === 'PENDING' ||
      annonce.coop_status === 'VALIDATED' ||
      annonce.coop_status === 'INCLUDED'
    ) {
      throw new BadRequestException(
        "Annonce confiée à la coop : modifications impossibles tant que la coop n'a pas rejeté.",
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
      include: {
        _count: {
          select: {
            // Compte les commandes générées depuis cette annonce.
            // Si > 0, on refuse strictement la suppression — le farmer
            // doit d'abord livrer ou annuler chaque commande individuelle.
            commandes_vente: true,
          },
        },
      },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable ou non autorisée.');

    // Même verrou que updateAnnonceVente : PENDING/VALIDATED/INCLUDED → la coop
    // est responsable, le farmer ne peut plus supprimer.
    //
    // Ordre des checks : coop_status d'abord (existant, testé en unit),
    // puis commandes (ajouté plus tard).
    if (
      annonce.coop_status === 'PENDING' ||
      annonce.coop_status === 'VALIDATED' ||
      annonce.coop_status === 'INCLUDED'
    ) {
      throw new BadRequestException(
        "Annonce confiée à la coop : suppression impossible tant que la coop n'a pas rejeté.",
      );
    }

    // Refus dur si une commande est en cours sur cette annonce. Annuler
    // ici sans gérer la commande laisserait le buyer dans le flou (paiement
    // immobilisé, attente livraison). Le farmer doit passer par la page
    // Commandes pour traiter chaque commande individuellement.
    //
    // `_count` peut être `undefined` dans les unit tests avec mocks
    // simplifiés — on traite "aucun count" comme 0 (= pas de commande).
    const nbCommandes = annonce._count?.commandes_vente ?? 0;
    if (nbCommandes > 0) {
      throw new BadRequestException(
        "Une commande est en cours sur cette annonce. Annule-la d'abord depuis ta page Commandes avant de supprimer l'annonce.",
      );
    }
    // Fenêtre de suppression limitée à 24h après création — au-delà,
    // l'annonce est considérée comme "publique et engagée" et le farmer
    // ne peut plus la retirer (les buyers ont pu la voir, peut-être
    // contactée, etc.). Si erreur de saisie, c'est le moment d'éditer
    // via PUT plutôt que de supprimer.
    //
    // Note : `coop_status === 'REJECTED'` libère cette règle ? Non —
    // la fenêtre 24h prime sur la chronologie coop. Si une coop a
    // rejeté à H+25, le farmer doit éditer (status PAUSED) au lieu de
    // supprimer.
    const ageMs = Date.now() - annonce.created_at.getTime();
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    if (ageMs > TWENTY_FOUR_HOURS_MS) {
      throw new BadRequestException(
        "Cette annonce a plus de 24h — suppression impossible. Tu peux la mettre en pause ou modifier ses détails.",
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
          users: {
            select: {
              id: true,
              full_name: true,
              rating: true,
              photo_url: true,
            },
          },
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
        users: { select: { id: true, full_name: true, rating: true, photo_url: true, reliability_score: true } },
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
