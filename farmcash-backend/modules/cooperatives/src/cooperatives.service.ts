// =====================================================================
//  SERVICE : CooperativesService
//  ---------------------------------------------------------------------
//  Logique métier centralisée du module coopératives.
//
//  Couvre :
//   • lookup public des coops (pour l'inscription FARMER)
//   • profil coop (création + commission + auto-distribution)
//   • adhésion bidirectionnelle :
//       - FARMER initie  → join_request  → COOP valide
//       - COOP   initie  → invitation    → FARMER valide
//   • gestion membres (liste, rôles, retrait)
//   • workflow annonces assignées :
//       PENDING → (pesée) → VALIDATED → (agrégation) → INCLUDED
//                   ↓
//                REJECTED
//   • agrégation N annonces VALIDATED → 1 publication_stock_coop
//   • distribution au prorata des contributions
//
//  Règle d'or :
//   • celui qui n'a PAS initié = celui qui valide
//   • 1 FARMER = 1 seule coop active (contrainte unique partielle en DB)
//   • annonce VALIDATED ou INCLUDED → verrouillée pour le farmer
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService, NotificationType } from '@farmcash/notifications';
import {
  AggregatePublicationDto,
  CoopAnnonceStatus,
  CoopMemberRole,
  CreateInvitationDto,
  CreateJoinRequestDto,
  CreatePublicationCoopDto,
  HandleInvitationDto,
  HandleJoinRequestDto,
  ListAdvancesQueryDto,
  ListCooperativesQueryDto,
  ListMembersQueryDto,
  ListPendingAnnoncesQueryDto,
  ListerPublicationsCoopQueryDto,
  PayAdvanceDto,
  RejectAnnonceDto,
  UpdateMemberRoleDto,
  UpdatePublicationCoopDto,
  UpsertCoopProfileDto,
  ValidateAnnonceDto,
  ValidatePrevisionDto,
} from './dto/cooperatives.dto';

const FEE_PRODUCT_DEFAULT = 0.03;

@Injectable()
export class CooperativesService {
  private readonly logger = new Logger(CooperativesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Notif "fire-and-forget" — log si échec. Type MARKETPLACE pour les
   * événements coop qui concernent les annonces des producteurs.
   */
  private notifyFarmer(
    userId: string,
    titre: string,
    body: string,
    data: Record<string, string>,
  ): void {
    this.notifications
      .create({
        user_id: userId,
        type: NotificationType.MARKETPLACE,
        titre,
        body,
        data,
      })
      .catch((e) => this.logger.warn(`Notif KO: ${e?.message}`));
  }

  // ===================================================================
  //  PUBLIC LOOKUP (pour l'inscription FARMER)
  // ===================================================================

  /**
   * Liste publique paginée des coopératives — alimente le dropdown
   * d'inscription côté mobile ("À quelle coop appartiens-tu ?").
   * Ne renvoie que les champs publics (pas de PII).
   */
  async listPublic(query: ListCooperativesQueryDto) {
    const { page = 1, limit = 20, search, region_id } = query;
    const where: Prisma.cooperative_profilesWhereInput = {};
    if (search) where.nom = { contains: search, mode: 'insensitive' };
    if (region_id) where.region_id = region_id;

    const [data, total] = await Promise.all([
      this.prisma.cooperative_profiles.findMany({
        where,
        select: {
          id: true,
          nom: true,
          numero_agrement: true,
          region_id: true,
          ville_id: true,
          nb_membres: true,
          produits: true,
          created_at: true,
        },
        orderBy: { nom: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.cooperative_profiles.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  async getPublic(id: string) {
    const coop = await this.prisma.cooperative_profiles.findUnique({
      where: { id },
      select: {
        id: true,
        nom: true,
        numero_agrement: true,
        region_id: true,
        ville_id: true,
        nb_membres: true,
        produits: true,
        commission_rate: true, // utile pour info des futurs membres
        created_at: true,
      },
    });
    if (!coop) throw new NotFoundException('Coopérative introuvable.');
    return coop;
  }

  // ===================================================================
  //  PROFIL COOP
  // ===================================================================

  /**
   * Met à jour le profil de la coop. La création initiale est faite à
   * l'inscription (auth.service.creerProfilRole) avec un nom par défaut ;
   * cette route permet de compléter raison sociale + commission + config.
   */
  async upsertProfile(userId: string, dto: UpsertCoopProfileDto) {
    const existing = await this.prisma.cooperative_profiles.findUnique({
      where: { user_id: userId },
    });
    if (!existing) {
      throw new ForbiddenException("Vous n'êtes pas le compte d'une coopérative.");
    }
    return this.prisma.cooperative_profiles.update({
      where: { id: existing.id },
      data: {
        nom: dto.nom,
        numero_agrement: dto.numero_agrement,
        region_id: dto.region_id,
        ville_id: dto.ville_id,
        nb_membres: dto.nb_membres,
        commission_rate: dto.commission_rate as any,
        auto_distribute: dto.auto_distribute,
      },
    });
  }

  // ===================================================================
  //  ADHÉSION — FARMER initie (join-requests)
  // ===================================================================

  /**
   * Un FARMER demande à rejoindre une coopérative.
   * Vérifie :
   *   • Que la coop existe
   *   • Que le farmer n'est pas déjà membre actif d'une coop (anti-1-coop-max)
   *   • Qu'il n'a pas déjà une demande PENDING vers cette coop
   */
  async createJoinRequest(farmerId: string, dto: CreateJoinRequestDto) {
    const coop = await this.prisma.cooperative_profiles.findUnique({
      where: { id: dto.cooperative_id },
    });
    if (!coop) throw new NotFoundException('Coopérative introuvable.');

    const activeMembership = await this.prisma.cooperative_members.findFirst({
      where: { member_id: farmerId, is_active: true },
    });
    if (activeMembership) {
      throw new ConflictException(
        'Vous êtes déjà membre actif d\'une coopérative. Quittez-la avant.',
      );
    }

    const pending = await this.prisma.coop_join_requests.findFirst({
      where: { farmer_id: farmerId, cooperative_id: dto.cooperative_id, status: 'PENDING' },
    });
    if (pending) {
      throw new ConflictException('Demande déjà en attente.');
    }

    return this.prisma.coop_join_requests.create({
      data: {
        cooperative_id: dto.cooperative_id,
        farmer_id: farmerId,
        message: dto.message,
        status: 'PENDING',
      },
    });
  }

  /** [COOP] liste les demandes d'adhésion en attente */
  async listJoinRequests(coopId: string) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    return this.prisma.coop_join_requests.findMany({
      where: { cooperative_id: coopId, status: 'PENDING' },
      include: {
        users_coop_join_requests_farmer_idTousers: {
          select: { id: true, full_name: true, phone: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** [COOP] accepte ou refuse une demande */
  async handleJoinRequest(
    coopId: string,
    handlerId: string,
    requestId: string,
    dto: HandleJoinRequestDto,
  ) {
    const req = await this.prisma.coop_join_requests.findUnique({
      where: { id: requestId },
    });
    if (!req) throw new NotFoundException('Demande introuvable.');
    if (req.cooperative_id !== coopId) {
      throw new ForbiddenException('Cette demande ne concerne pas votre coopérative.');
    }
    if (req.status !== 'PENDING') {
      throw new ConflictException('Demande déjà traitée.');
    }

    // Récupère le nom de la coop pour le body de la notif (hors-TX).
    const coopProfile = await this.prisma.cooperative_profiles.findUnique({
      where: { id: coopId },
      select: { nom: true },
    });
    const coopNom = coopProfile?.nom ?? 'votre coopérative';

    if (dto.decision === 'ACCEPTED') {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Marque la demande
        await tx.coop_join_requests.update({
          where: { id: requestId },
          data: { status: 'ACCEPTED', handled_by: handlerId, handled_at: new Date() },
        });
        // 2. Crée le lien membre (is_active = true → unique partielle protège)
        await tx.cooperative_members.create({
          data: {
            cooperative_id: coopId,
            member_id: req.farmer_id,
            role_in_coop: CoopMemberRole.MEMBER,
            date_adhesion: new Date(),
            is_active: true,
          },
        });
        // 3. Synchronise users.cooperative_id + producteur_profiles.coop_id
        await this.syncFarmerCoopId(tx, req.farmer_id, coopId);
        return { accepted: true };
      });

      // Notif farmer (best-effort).
      try {
        await this.notifications.create({
          user_id: req.farmer_id,
          type: NotificationType.COOP_JOIN_ACCEPTED,
          titre: 'Adhésion acceptée',
          body: `Vous êtes désormais membre de ${coopNom}.`,
          data: { cooperative_id: coopId },
        });
      } catch (err) {
        this.logger.warn(
          `Notif COOP_JOIN_ACCEPTED KO farmer=${req.farmer_id}: ${(err as Error).message}`,
        );
      }

      return result;
    }

    // REJECTED
    await this.prisma.coop_join_requests.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        handled_by: handlerId,
        handled_at: new Date(),
        rejection_reason: dto.rejection_reason,
      },
    });

    // Notif farmer (best-effort).
    try {
      const motif = dto.rejection_reason
        ? ` Motif : ${dto.rejection_reason}`
        : '';
      await this.notifications.create({
        user_id: req.farmer_id,
        type: NotificationType.COOP_JOIN_REJECTED,
        titre: 'Adhésion refusée',
        body: `Votre demande d'adhésion à ${coopNom} a été refusée.${motif}`,
        data: { cooperative_id: coopId },
      });
    } catch (err) {
      this.logger.warn(
        `Notif COOP_JOIN_REJECTED KO farmer=${req.farmer_id}: ${(err as Error).message}`,
      );
    }

    return { accepted: false };
  }

  // ===================================================================
  //  ADHÉSION — COOP initie (invitations)
  // ===================================================================

  /**
   * La COOP envoie une invitation à un numéro de téléphone.
   *   • Si le user existe déjà : on lie invited_user_id, il acceptera
   *     depuis son app (notification).
   *   • Sinon : on garde le téléphone, et au moment où ce numéro
   *     s'inscrit, l'invitation est résolue.
   */
  async createInvitation(coopId: string, inviterId: string, dto: CreateInvitationDto) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');

    const phone = dto.invited_phone.trim();
    const existingUser = await this.prisma.users.findUnique({
      where: { phone },
      select: { id: true, role: true },
    });

    // Le user invité doit être (ou pouvoir devenir) un FARMER
    if (existingUser && existingUser.role !== 'FARMER') {
      throw new BadRequestException(
        'Ce numéro est utilisé par un compte non-FARMER.',
      );
    }

    return this.prisma.coop_invitations.create({
      data: {
        cooperative_id: coopId,
        invited_phone: phone,
        invited_user_id: existingUser?.id,
        invited_by: inviterId,
        message: dto.message,
        status: 'PENDING',
      },
    });
  }

  /** [FARMER] liste les invitations qui le concernent (par user_id ou par phone) */
  async listMyInvitations(farmerId: string, farmerPhone: string) {
    return this.prisma.coop_invitations.findMany({
      where: {
        status: 'PENDING',
        OR: [{ invited_user_id: farmerId }, { invited_phone: farmerPhone }],
      },
      include: {
        cooperative_profiles: {
          select: { id: true, nom: true, region_id: true, nb_membres: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** [FARMER] accepte ou refuse une invitation */
  async handleInvitation(
    farmerId: string,
    farmerPhone: string,
    invitationId: string,
    dto: HandleInvitationDto,
  ) {
    const inv = await this.prisma.coop_invitations.findUnique({
      where: { id: invitationId },
    });
    if (!inv) throw new NotFoundException('Invitation introuvable.');

    const isOwner =
      inv.invited_user_id === farmerId || inv.invited_phone === farmerPhone;
    if (!isOwner) throw new ForbiddenException('Cette invitation ne vous est pas adressée.');
    if (inv.status !== 'PENDING') throw new ConflictException('Déjà traitée.');

    if (dto.decision === 'ACCEPTED') {
      const activeMembership = await this.prisma.cooperative_members.findFirst({
        where: { member_id: farmerId, is_active: true },
      });
      if (activeMembership) {
        throw new ConflictException(
          'Vous êtes déjà membre actif d\'une coopérative.',
        );
      }
      return this.prisma.$transaction(async (tx) => {
        await tx.coop_invitations.update({
          where: { id: invitationId },
          data: { status: 'ACCEPTED', handled_at: new Date(), invited_user_id: farmerId },
        });
        await tx.cooperative_members.create({
          data: {
            cooperative_id: inv.cooperative_id,
            member_id: farmerId,
            role_in_coop: CoopMemberRole.MEMBER,
            date_adhesion: new Date(),
            is_active: true,
          },
        });
        await this.syncFarmerCoopId(tx, farmerId, inv.cooperative_id);
        return { accepted: true };
      });
    }

    await this.prisma.coop_invitations.update({
      where: { id: invitationId },
      data: { status: 'REJECTED', handled_at: new Date() },
    });
    return { accepted: false };
  }

  // ===================================================================
  //  GESTION DES MEMBRES
  // ===================================================================

  async listMembers(coopId: string, query: ListMembersQueryDto) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    const { page = 1, limit = 20, role } = query;
    const where: Prisma.cooperative_membersWhereInput = {
      cooperative_id: coopId,
      is_active: true,
    };
    if (role) where.role_in_coop = role;
    const [data, total] = await Promise.all([
      this.prisma.cooperative_members.findMany({
        where,
        include: {
          users: { select: { id: true, full_name: true, phone: true } },
        },
        orderBy: { date_adhesion: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.cooperative_members.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  /** [COOP] retire un membre (désactive) */
  async removeMember(coopId: string, memberId: string) {
    const m = await this.prisma.cooperative_members.findFirst({
      where: { cooperative_id: coopId, member_id: memberId, is_active: true },
    });
    if (!m) throw new NotFoundException('Membre actif introuvable.');

    return this.prisma.$transaction(async (tx) => {
      await tx.cooperative_members.update({
        where: { id: m.id },
        data: { is_active: false },
      });
      await this.syncFarmerCoopId(tx, memberId, null);
      return { removed: true };
    });
  }

  /** [COOP] change le rôle d'un membre (promotion GERANT/TRESORIER/MEMBER) */
  async updateMemberRole(
    coopId: string,
    memberUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const m = await this.prisma.cooperative_members.findFirst({
      where: { cooperative_id: coopId, member_id: memberUserId, is_active: true },
    });
    if (!m) throw new NotFoundException('Membre actif introuvable.');
    return this.prisma.cooperative_members.update({
      where: { id: m.id },
      data: { role_in_coop: dto.role_in_coop },
    });
  }

  // ===================================================================
  //  ANNONCES ASSIGNÉES — workflow validation
  // ===================================================================

  /**
   * [COOP] liste les annonces de ses membres en attente de pesée.
   * Par défaut filtre sur PENDING (les nouvelles déclarations).
   */
  async listAssignedAnnonces(coopId: string, query: ListPendingAnnoncesQueryDto) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    const { page = 1, limit = 20, status = CoopAnnonceStatus.PENDING } = query;
    const where: Prisma.annonces_venteWhereInput = {
      assigned_to_cooperative_id: coopId,
      coop_status: status,
    };
    const [data, total] = await Promise.all([
      this.prisma.annonces_vente.findMany({
        where,
        include: {
          users: { select: { id: true, full_name: true, phone: true } },
          produits_agricoles: { select: { id: true, nom: true, slug: true } },
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.annonces_vente.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  /**
   * [COOP] valide une annonce après pesée terrain.
   *   • Peut corriger la quantité (poids réel ≠ poids déclaré)
   *   • Peut corriger la qualité
   *   • Verrouille l'annonce : le farmer ne peut plus la modifier
   */
  async validateAnnonce(
    coopId: string,
    handlerId: string,
    annonceId: string,
    dto: ValidateAnnonceDto,
  ) {
    const a = await this.prisma.annonces_vente.findUnique({ where: { id: annonceId } });
    if (!a) throw new NotFoundException('Annonce introuvable.');
    if (a.assigned_to_cooperative_id !== coopId) {
      throw new ForbiddenException('Annonce non assignée à votre coopérative.');
    }
    if (a.coop_status !== CoopAnnonceStatus.PENDING) {
      throw new ConflictException(`Annonce déjà en statut ${a.coop_status}.`);
    }
    const updated = await this.prisma.annonces_vente.update({
      where: { id: annonceId },
      data: {
        coop_status: CoopAnnonceStatus.VALIDATED,
        quantite_kg_validee: dto.quantite_kg_reelle as any,
        qualite_validee: dto.qualite_reelle as any,
        notes_pesee: dto.notes_pesee,
        validee_at: new Date(),
        validee_by: handlerId,
      },
    });
    this.notifyFarmer(
      a.farmer_id,
      '✅ Annonce validée par votre coop',
      `Pesée confirmée : ${dto.quantite_kg_reelle} kg. Votre lot est prêt à être agrégé.`,
      { annonce_id: annonceId },
    );
    return updated;
  }

  /** [COOP] refuse une annonce (libère le farmer) */
  async rejectAnnonce(coopId: string, annonceId: string, dto: RejectAnnonceDto) {
    const a = await this.prisma.annonces_vente.findUnique({ where: { id: annonceId } });
    if (!a) throw new NotFoundException('Annonce introuvable.');
    if (a.assigned_to_cooperative_id !== coopId) {
      throw new ForbiddenException('Annonce non assignée à votre coopérative.');
    }
    if (a.coop_status === CoopAnnonceStatus.INCLUDED) {
      throw new ConflictException('Annonce déjà incluse dans une publication.');
    }
    const updated = await this.prisma.annonces_vente.update({
      where: { id: annonceId },
      data: {
        coop_status: CoopAnnonceStatus.REJECTED,
        rejected_reason: dto.rejection_reason,
      },
    });
    this.notifyFarmer(
      a.farmer_id,
      '❌ Annonce refusée par la coop',
      `Motif : ${dto.rejection_reason}. Vous pouvez modifier et resoumettre.`,
      { annonce_id: annonceId },
    );
    return updated;
  }

  // ===================================================================
  //  PRÉVISIONS ASSIGNÉES — même workflow que les annonces
  // ===================================================================

  /** [COOP] liste les prévisions de récolte attribuées à la coop */
  async listAssignedPrevisions(
    coopId: string,
    query: ListPendingAnnoncesQueryDto,
  ) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    const { page = 1, limit = 20, status = CoopAnnonceStatus.PENDING } = query;
    const where: Prisma.previsions_productionWhereInput = {
      assigned_to_cooperative_id: coopId,
      coop_status: status,
    };
    const [data, total] = await Promise.all([
      this.prisma.previsions_production.findMany({
        where,
        include: {
          users: { select: { id: true, full_name: true, phone: true } },
          produits_agricoles: { select: { id: true, nom: true, slug: true } },
          parcelle: { select: { id: true, nom: true, superficie_ha: true } },
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.previsions_production.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  /**
   * [COOP] valide une prévision après inspection terrain.
   * Peut corriger la quantité prévisionnelle. Verrouille la prévision :
   * elle devient réservable par les BUYER (les acheteurs ne réservent
   * que des prévisions VALIDATED — anti-promesse fantaisiste).
   */
  async validatePrevision(
    coopId: string,
    handlerId: string,
    previsionId: string,
    dto: ValidatePrevisionDto,
  ) {
    const p = await this.prisma.previsions_production.findUnique({
      where: { id: previsionId },
    });
    if (!p) throw new NotFoundException('Prévision introuvable.');
    if (p.assigned_to_cooperative_id !== coopId) {
      throw new ForbiddenException('Prévision non assignée à votre coopérative.');
    }
    if (p.coop_status !== CoopAnnonceStatus.PENDING) {
      throw new ConflictException(`Prévision déjà en statut ${p.coop_status}.`);
    }
    return this.prisma.previsions_production.update({
      where: { id: previsionId },
      data: {
        coop_status: CoopAnnonceStatus.VALIDATED,
        quantite_kg_validee: dto.quantite_kg_validee as any,
        notes_inspection: dto.notes_inspection,
        validee_at: new Date(),
        validee_by: handlerId,
      },
    });
  }

  /** [COOP] refuse une prévision (libère le farmer) */
  async rejectPrevision(coopId: string, previsionId: string, dto: RejectAnnonceDto) {
    const p = await this.prisma.previsions_production.findUnique({
      where: { id: previsionId },
    });
    if (!p) throw new NotFoundException('Prévision introuvable.');
    if (p.assigned_to_cooperative_id !== coopId) {
      throw new ForbiddenException('Prévision non assignée à votre coopérative.');
    }
    return this.prisma.previsions_production.update({
      where: { id: previsionId },
      data: {
        coop_status: CoopAnnonceStatus.REJECTED,
        rejected_reason: dto.rejection_reason,
      },
    });
  }

  /**
   * Attache une annonce existante à une coopérative et la passe en
   * statut PENDING (workflow de validation par la coop).
   * Vérifie que le farmer est bien membre actif de la coop ciblée.
   *
   * Cette méthode est appelée par marketplace.service.createAnnonceVente
   * juste après la création de l'annonce, et par un éventuel endpoint
   * futur `POST /coop/annonces-vente/:id/assign` si on veut permettre
   * d'assigner après-coup.
   */
  async attachAnnonceToCoop(
    annonceId: string,
    cooperativeId: string,
    farmerId: string,
  ): Promise<void> {
    const membership = await this.prisma.cooperative_members.findFirst({
      where: {
        member_id: farmerId,
        cooperative_id: cooperativeId,
        is_active: true,
      },
    });
    if (!membership) {
      throw new ForbiddenException(
        "Vous n'êtes pas membre actif de cette coopérative.",
      );
    }

    await this.prisma.annonces_vente.update({
      where: { id: annonceId },
      data: {
        assigned_to_cooperative_id: cooperativeId,
        coop_status: 'PENDING',
      },
    });
  }

  /**
   * [COOP] offres d'achat visibles par ma coop :
   *  • SPECIFIC_COOPERATIVE avec target_cooperative_id = ma coop
   *  • ALL_COOPERATIVES (visibles par toutes les coops de la plateforme)
   * Les PUBLIC n'apparaissent PAS ici (elles sont sur le marketplace).
   */
  async listTargetedBuyOffers(coopId: string) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    return this.prisma.annonces_achat.findMany({
      where: {
        is_active: true,
        OR: [
          { target_audience: 'ALL_COOPERATIVES' },
          { target_audience: 'SPECIFIC_COOPERATIVE', target_cooperative_id: coopId },
        ],
      },
      include: {
        users: { select: { id: true, full_name: true, phone: true } },
        produits_agricoles: { select: { id: true, nom: true, slug: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // ===================================================================
  //  AGRÉGATION : N annonces VALIDATED → 1 publication_stock_coop
  // ===================================================================

  /**
   * Sélectionne N annonces VALIDATED, calcule la quantité totale
   * (sommes des quantités validées), crée une publication coop et
   * crée les `publication_contributions` qui tracent qui a contribué.
   * Verrouille toutes les annonces en INCLUDED.
   */
  async aggregateIntoPublication(coopId: string, dto: AggregatePublicationDto) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    if (!dto.annonce_ids?.length)
      throw new BadRequestException('Aucune annonce sélectionnée.');

    const annonces = await this.prisma.annonces_vente.findMany({
      where: {
        id: { in: dto.annonce_ids },
        assigned_to_cooperative_id: coopId,
        coop_status: CoopAnnonceStatus.VALIDATED,
      },
    });
    if (annonces.length !== dto.annonce_ids.length) {
      throw new BadRequestException(
        'Toutes les annonces doivent être VALIDATED et assignées à votre coop.',
      );
    }

    // Un seul produit à la fois (publication = 1 lot homogène)
    const produitId = annonces[0].produit_id;
    if (!produitId || annonces.some((a) => a.produit_id !== produitId)) {
      throw new BadRequestException(
        'Toutes les annonces doivent concerner le même produit.',
      );
    }

    const totalKg = annonces.reduce(
      (sum, a) => sum + Number(a.quantite_kg_validee ?? 0),
      0,
    );
    if (totalKg <= 0) {
      throw new BadRequestException('Quantité totale validée nulle.');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Crée la publication
      const pub = await tx.publications_stock_coop.create({
        data: {
          cooperative_id: coopId,
          produit_id: produitId,
          quantite_kg: totalKg,
          prix_par_kg: dto.prix_par_kg,
          qualite: dto.qualite as any,
          region_id: dto.region_id,
          ville_id: dto.ville_id,
          adresse_detail: dto.adresse_detail,
          is_active: true,
        },
      });

      // 2. Crée les contributions (part_pct à la 4e décimale)
      for (const a of annonces) {
        const qte = Number(a.quantite_kg_validee ?? 0);
        await tx.publication_contributions.create({
          data: {
            publication_id: pub.id,
            annonce_vente_id: a.id,
            farmer_id: a.farmer_id,
            quantite_kg: qte,
            prix_kg: dto.prix_par_kg,
            part_pct: Number((qte / totalKg).toFixed(4)),
          },
        });
      }

      // 3. Verrouille les annonces en INCLUDED
      await tx.annonces_vente.updateMany({
        where: { id: { in: dto.annonce_ids } },
        data: {
          coop_status: CoopAnnonceStatus.INCLUDED,
          coop_publication_id: pub.id,
        },
      });

      return { publication: pub, total_kg: totalKg, contributors: annonces.length };
    }).then((res) => {
      // Notifie chaque contributeur (hors transaction pour ne pas
      // bloquer la requête HTTP). On utilise la liste des annonces
      // pour retrouver les farmers concernés.
      for (const a of annonces) {
        this.notifyFarmer(
          a.farmer_id,
          '🛒 Votre lot est sur le marché',
          `Inclus dans une publication ${res.total_kg} kg à ${dto.prix_par_kg} F/kg.`,
          { annonce_id: a.id, publication_id: res.publication.id },
        );
      }
      return res;
    });
  }

  /** Détail de qui a contribué à une publication */
  async getContributions(coopId: string, publicationId: string) {
    const pub = await this.prisma.publications_stock_coop.findUnique({
      where: { id: publicationId },
    });
    if (!pub) throw new NotFoundException('Publication introuvable.');
    if (pub.cooperative_id !== coopId) {
      throw new ForbiddenException('Cette publication ne vous appartient pas.');
    }
    return this.prisma.publication_contributions.findMany({
      where: { publication_id: publicationId },
      include: {
        users: { select: { id: true, full_name: true, phone: true } },
        annonces_vente: { select: { id: true, titre: true, traceability_id: true } },
      },
      orderBy: { part_pct: 'desc' },
    });
  }

  // ===================================================================
  //  DISTRIBUTION : payouts au prorata des contributions
  // ===================================================================

  /**
   * Calcule la distribution suggérée pour une publication vendue :
   *   total reçu - commission coop = à distribuer
   *   chaque membre touche au prorata de sa part_pct
   *
   * Si dto.execute = true : exécute réellement les payouts via une
   *   transaction qui crédite les wallets des membres + débite la coop.
   *
   * NOTE : la frais plateforme (3%) a déjà été prélevée au moment
   *   du confirm-delivery par finance.service.ts. Ici on travaille
   *   sur le montant déjà reçu par la coop.
   */
  async distributePublication(
    coopId: string,
    publicationId: string,
    execute = true,
  ) {
    const pub = await this.prisma.publications_stock_coop.findUnique({
      where: { id: publicationId },
    });
    if (!pub) throw new NotFoundException('Publication introuvable.');
    if (pub.cooperative_id !== coopId) {
      throw new ForbiddenException('Publication non vôtre.');
    }

    const coopProfile = await this.prisma.cooperative_profiles.findUnique({
      where: { id: coopId },
      select: { commission_rate: true, user_id: true },
    });
    if (!coopProfile) throw new NotFoundException('Profil coop introuvable.');

    const contribs = await this.prisma.publication_contributions.findMany({
      where: { publication_id: publicationId, paid_at: null },
    });
    if (!contribs.length) {
      throw new BadRequestException('Aucune contribution à distribuer.');
    }

    // Total reçu = quantité vendue × prix unitaire
    const totalSold = Number(pub.quantite_kg) * Number(pub.prix_par_kg ?? 0);
    const commissionRate = Number(coopProfile.commission_rate ?? 0.05);
    const commission = Math.round(totalSold * commissionRate);
    const distributable = totalSold - commission;

    // Récupère les avances PAID encore actives liées aux annonces sources
    // (les remboursements sont déduits de la part de leur bénéficiaire).
    const annonceIds = contribs.map((c) => c.annonce_vente_id);
    const activeAdvances = await this.prisma.coop_advance_payments.findMany({
      where: {
        cooperative_id: coopId,
        annonce_vente_id: { in: annonceIds },
        status: 'PAID',
      },
    });
    const advanceByAnnonce = new Map<string, { id: string; amount: number }[]>();
    for (const a of activeAdvances) {
      const arr = advanceByAnnonce.get(a.annonce_vente_id!) ?? [];
      arr.push({ id: a.id, amount: Number(a.amount) });
      advanceByAnnonce.set(a.annonce_vente_id!, arr);
    }

    // Calcule les parts (en F entiers — pas de centimes en CI).
    // Pour chaque contributeur : montant brut au prorata - somme avances.
    // Cap à 0 si avances > part brute (la coop a sur-payé : sa perte).
    const breakdown = contribs.map((c) => {
      const grossAmount = Math.round(distributable * Number(c.part_pct));
      const advances = advanceByAnnonce.get(c.annonce_vente_id) ?? [];
      const totalAdvance = advances.reduce((sum, a) => sum + a.amount, 0);
      const netAmount = Math.max(0, grossAmount - totalAdvance);
      return {
        farmer_id: c.farmer_id,
        contribution_id: c.id,
        annonce_vente_id: c.annonce_vente_id,
        quantite_kg: Number(c.quantite_kg),
        part_pct: Number(c.part_pct),
        gross_amount: grossAmount,
        advance_deducted: totalAdvance,
        amount: netAmount,
        advance_ids: advances.map((a) => a.id),
      };
    });

    if (!execute) {
      return {
        total_sold: totalSold,
        coop_commission: commission,
        distributable,
        breakdown,
        executed: false,
      };
    }

    // Exécute la distribution
    return this.prisma.$transaction(async (tx) => {
      const coopWallet = await tx.wallets.findUnique({
        where: { user_id_currency: { user_id: coopProfile.user_id, currency: 'XOF' } },
      });
      if (!coopWallet) throw new BadRequestException('Wallet coop introuvable.');
      const coopBalance = Number(coopWallet.balance);
      // On débite uniquement le NET (après déduction des avances —
      // les avances ont déjà été débitées au moment du payAdvance).
      const totalNetToTransfer = breakdown.reduce((s, b) => s + b.amount, 0);
      if (coopBalance < totalNetToTransfer) {
        throw new BadRequestException(
          `Solde coop insuffisant (${coopBalance} < ${totalNetToTransfer}).`,
        );
      }

      // 1. Débite le wallet coop du total net à distribuer
      if (totalNetToTransfer > 0) {
        await tx.wallets.update({
          where: { id: coopWallet.id },
          data: { balance: { decrement: totalNetToTransfer } },
        });
      }

      // 2. Crédite chaque membre + marque la contribution comme payée
      //    + marque les avances comme REIMBURSED
      for (const b of breakdown) {
        if (b.amount > 0) {
          await tx.wallets.upsert({
            where: {
              user_id_currency: { user_id: b.farmer_id, currency: 'XOF' },
            },
            create: { user_id: b.farmer_id, currency: 'XOF', balance: b.amount },
            update: { balance: { increment: b.amount } },
          });
        }
        await tx.publication_contributions.update({
          where: { id: b.contribution_id },
          data: { paid_amount: b.amount, paid_at: new Date() },
        });
        if (b.advance_ids.length) {
          await tx.coop_advance_payments.updateMany({
            where: { id: { in: b.advance_ids } },
            data: { status: 'REIMBURSED', reimbursed_at: new Date() },
          });
        }
      }

      return {
        total_sold: totalSold,
        coop_commission: commission,
        distributable,
        breakdown,
        executed: true,
      };
    }).then((res) => {
      // Notif à chaque contributeur après distribution réussie.
      for (const b of res.breakdown) {
        const msg = b.advance_deducted
          ? `Vente : ${b.gross_amount} F. Avance déduite : ${b.advance_deducted} F. Net versé : ${b.amount} F.`
          : `Vente réalisée. Net versé : ${b.amount} FCFA.`;
        this.notifyFarmer(
          b.farmer_id,
          '💵 Paiement reçu',
          msg,
          {
            publication_id: publicationId,
            annonce_id: b.annonce_vente_id,
          },
        );
      }
      return res;
    });
  }

  // ===================================================================
  //  VUE PRODUCTEUR — mes annonces côté coop (contexte enrichi)
  // ===================================================================

  /**
   * Renvoie pour UNE annonce du farmer le contexte coop complet :
   * statut, quantité validée, publication associée (si INCLUDED),
   * ma part, revenu projeté en temps réel, avances reçues, négos en
   * cours sur la publication.
   *
   * Le revenu projeté se base sur :
   *   • le meilleur prix entre publication.prix_par_kg et la plus
   *     haute contre_offre ACCEPTED sur cette pub
   *   • diminué de la commission coop
   *   • diminué des avances déjà reçues
   */
  async getMyAnnonceContext(farmerId: string, annonceId: string) {
    const a = await this.prisma.annonces_vente.findUnique({
      where: { id: annonceId },
      include: {
        produits_agricoles: { select: { nom: true } },
        cooperative_profiles: {
          select: { id: true, nom: true, commission_rate: true },
        },
      },
    });
    if (!a) throw new NotFoundException('Annonce introuvable.');
    if (a.farmer_id !== farmerId) {
      throw new ForbiddenException("Cette annonce ne vous appartient pas.");
    }
    if (!a.assigned_to_cooperative_id) {
      throw new BadRequestException(
        "Cette annonce n'est pas attribuée à une coopérative.",
      );
    }

    const result: any = {
      annonce: {
        id: a.id,
        titre: a.titre,
        produit: a.produits_agricoles?.nom,
        prix_declare_kg: Number(a.prix_par_kg),
        quantite_declaree_kg: Number(a.quantite_kg),
        quantite_validee_kg: a.quantite_kg_validee
          ? Number(a.quantite_kg_validee)
          : null,
        coop_status: a.coop_status,
        validee_at: a.validee_at,
        notes_pesee: a.notes_pesee,
        rejected_reason: a.rejected_reason,
      },
      cooperative: a.cooperative_profiles && {
        id: a.cooperative_profiles.id,
        nom: a.cooperative_profiles.nom,
        commission_rate: Number(a.cooperative_profiles.commission_rate),
      },
    };

    // Contexte publication si INCLUDED
    if (a.coop_status === CoopAnnonceStatus.INCLUDED && a.coop_publication_id) {
      const pub = await this.prisma.publications_stock_coop.findUnique({
        where: { id: a.coop_publication_id },
      });
      const myContrib = await this.prisma.publication_contributions.findFirst({
        where: { publication_id: a.coop_publication_id, farmer_id: farmerId },
      });
      const contribCount = await this.prisma.publication_contributions.count({
        where: { publication_id: a.coop_publication_id },
      });

      // Meilleur prix actuel : max(publication, contre-offres ACCEPTED)
      const acceptedCO = await this.prisma.contre_offres_coop.findMany({
        where: { publication_id: a.coop_publication_id, status: 'ACCEPTED' },
        select: { prix_propose_kg: true, quantite_kg: true },
      });
      const pendingCO = await this.prisma.contre_offres_coop.findMany({
        where: {
          publication_id: a.coop_publication_id,
          status: { in: ['PENDING', 'COUNTER_OFFER'] },
        },
        select: { id: true, prix_propose_kg: true, quantite_kg: true, status: true },
      });

      const pubPrice = Number(pub?.prix_par_kg ?? 0);
      const bestPrice = Math.max(
        pubPrice,
        ...acceptedCO.map((c) => Number(c.prix_propose_kg)),
        0,
      );

      // Revenu projeté = qte_validée × bestPrice × (1 - commission_coop) - avances
      const commissionRate = Number(
        a.cooperative_profiles?.commission_rate ?? 0.05,
      );
      const myQte = myContrib ? Number(myContrib.quantite_kg) : 0;
      const grossRevenue = myQte * bestPrice;
      const afterCommission = Math.round(grossRevenue * (1 - commissionRate));

      const advancesAgg = await this.prisma.coop_advance_payments.aggregate({
        where: {
          farmer_id: farmerId,
          annonce_vente_id: annonceId,
          status: 'PAID',
        },
        _sum: { amount: true },
      });
      const advancesReceived = Number(advancesAgg._sum.amount ?? 0);

      result.publication = {
        id: pub?.id,
        prix_vente_kg: pubPrice,
        quantite_totale_kg: pub ? Number(pub.quantite_kg) : 0,
        nb_contributeurs: contribCount,
      };
      result.my_share = myContrib && {
        quantite_kg: myQte,
        part_pct: Number(myContrib.part_pct),
        already_paid: myContrib.paid_amount
          ? Number(myContrib.paid_amount)
          : null,
        paid_at: myContrib.paid_at,
      };
      result.projected_revenue = {
        gross_at_best_price: Math.round(grossRevenue),
        coop_commission: Math.round(grossRevenue * commissionRate),
        net_after_commission: afterCommission,
        advances_received: advancesReceived,
        net_after_advances: Math.max(0, afterCommission - advancesReceived),
        best_price_used: bestPrice,
      };
      result.active_negotiations = pendingCO.map((c) => ({
        id: c.id,
        // Volontairement anonymisé pour le farmer (privé entre buyer ↔ coop)
        prix_propose_kg: Number(c.prix_propose_kg),
        quantite_kg: Number(c.quantite_kg),
        status: c.status,
      }));
    } else {
      // Avances reçues même hors publication (ex. avance avant inclusion)
      const advancesAgg = await this.prisma.coop_advance_payments.aggregate({
        where: {
          farmer_id: farmerId,
          annonce_vente_id: annonceId,
          status: 'PAID',
        },
        _sum: { amount: true },
      });
      result.advances_received = Number(advancesAgg._sum.amount ?? 0);
    }

    return result;
  }

  /**
   * Liste compacte de toutes mes annonces gérées par une coop.
   * Pour l'écran "Mes annonces (côté coop)" en un seul appel.
   */
  async listMyAnnoncesWithCoopContext(farmerId: string) {
    const annonces = await this.prisma.annonces_vente.findMany({
      where: {
        farmer_id: farmerId,
        assigned_to_cooperative_id: { not: null },
      },
      include: {
        produits_agricoles: { select: { nom: true } },
        cooperative_profiles: { select: { id: true, nom: true } },
      },
      orderBy: { created_at: 'desc' },
    });
    return annonces.map((a) => ({
      id: a.id,
      titre: a.titre,
      produit: a.produits_agricoles?.nom,
      coop_id: a.assigned_to_cooperative_id,
      coop_nom: a.cooperative_profiles?.nom,
      coop_status: a.coop_status,
      prix_declare_kg: Number(a.prix_par_kg),
      quantite_declaree_kg: Number(a.quantite_kg),
      quantite_validee_kg: a.quantite_kg_validee
        ? Number(a.quantite_kg_validee)
        : null,
      coop_publication_id: a.coop_publication_id,
      created_at: a.created_at,
    }));
  }

  // ===================================================================
  //  AVANCES COOP → PRODUCTEUR
  // ===================================================================

  /**
   * La COOP verse une avance à un producteur. Plafond vérifié contre
   * la valeur de l'annonce d'origine (quantité validée si dispo, sinon
   * quantité déclarée × prix déclaré). Anti-double-paiement : on
   * compte les avances PAID existantes pour ne pas dépasser.
   *
   * Mouvement de wallet :
   *   • Débite le compte user_id de la coop
   *   • Crédite le compte du producteur
   *   • Crée la ligne coop_advance_payments (status PAID)
   *   • Marque l'avance comme REIMBURSED automatiquement lors de
   *     distributePublication (méthode existante, étendue plus bas).
   */
  async payAdvance(coopId: string, payerId: string, dto: PayAdvanceDto) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');

    // Bénéficiaire doit être un membre actif de cette coop
    const m = await this.prisma.cooperative_members.findFirst({
      where: { cooperative_id: coopId, member_id: dto.farmer_id, is_active: true },
    });
    if (!m) {
      throw new ForbiddenException(
        "Le bénéficiaire n'est pas membre actif de votre coopérative.",
      );
    }

    // Si annonce_vente_id fournie : check ownership + plafond
    let maxAllowed = Number.POSITIVE_INFINITY;
    if (dto.annonce_vente_id) {
      const a = await this.prisma.annonces_vente.findUnique({
        where: { id: dto.annonce_vente_id },
        select: {
          farmer_id: true,
          prix_par_kg: true,
          quantite_kg: true,
          quantite_kg_validee: true,
          assigned_to_cooperative_id: true,
          coop_status: true,
        },
      });
      if (!a) throw new NotFoundException('Annonce introuvable.');
      if (a.farmer_id !== dto.farmer_id) {
        throw new BadRequestException(
          "L'annonce n'appartient pas au bénéficiaire.",
        );
      }
      if (a.assigned_to_cooperative_id !== coopId) {
        throw new ForbiddenException("L'annonce n'est pas assignée à votre coop.");
      }
      if (a.coop_status === 'REJECTED') {
        throw new BadRequestException(
          "Annonce refusée — impossible de verser une avance.",
        );
      }
      const qte = a.quantite_kg_validee
        ? Number(a.quantite_kg_validee)
        : Number(a.quantite_kg);
      maxAllowed = qte * Number(a.prix_par_kg);

      // Déduit les avances déjà payées sur cette annonce
      const existing = await this.prisma.coop_advance_payments.aggregate({
        where: { annonce_vente_id: dto.annonce_vente_id, status: 'PAID' },
        _sum: { amount: true },
      });
      maxAllowed -= Number(existing._sum.amount ?? 0);
    }

    if (dto.amount > maxAllowed) {
      throw new BadRequestException(
        `Avance ${dto.amount} dépasse le plafond restant (${maxAllowed} FCFA).`,
      );
    }

    // Récupère les comptes wallet
    const coopProfile = await this.prisma.cooperative_profiles.findUnique({
      where: { id: coopId },
      select: { user_id: true, nom: true },
    });
    if (!coopProfile) throw new NotFoundException('Coop introuvable.');

    const result = await this.prisma.$transaction(async (tx) => {
      const coopWallet = await tx.wallets.findUnique({
        where: {
          user_id_currency: { user_id: coopProfile.user_id, currency: 'XOF' },
        },
      });
      if (!coopWallet || Number(coopWallet.balance) < dto.amount) {
        throw new BadRequestException(
          `Solde coop insuffisant (${coopWallet ? coopWallet.balance : 0} < ${dto.amount}).`,
        );
      }

      await tx.wallets.update({
        where: { id: coopWallet.id },
        data: { balance: { decrement: dto.amount } },
      });
      await tx.wallets.upsert({
        where: {
          user_id_currency: { user_id: dto.farmer_id, currency: 'XOF' },
        },
        create: { user_id: dto.farmer_id, currency: 'XOF', balance: dto.amount },
        update: { balance: { increment: dto.amount } },
      });

      const advance = await tx.coop_advance_payments.create({
        data: {
          cooperative_id: coopId,
          farmer_id: dto.farmer_id,
          annonce_vente_id: dto.annonce_vente_id,
          amount: dto.amount,
          status: 'PAID',
          notes: dto.notes,
          paid_by: payerId,
        },
      });
      return advance;
    });

    this.logger.log(
      `Avance ${dto.amount} F : ${coopProfile.nom} → farmer ${dto.farmer_id}`,
    );
    this.notifyFarmer(
      dto.farmer_id,
      '💰 Avance reçue de votre coop',
      `${coopProfile.nom} vous a versé ${dto.amount} FCFA d'avance.`,
      {
        advance_id: result.id,
        ...(dto.annonce_vente_id && { annonce_id: dto.annonce_vente_id }),
      },
    );
    return result;
  }

  async listAdvances(coopId: string, query: ListAdvancesQueryDto) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    const { page = 1, limit = 20, status } = query;
    const where: Prisma.coop_advance_paymentsWhereInput = {
      cooperative_id: coopId,
      ...(status && { status }),
    };
    const [data, total] = await Promise.all([
      this.prisma.coop_advance_payments.findMany({
        where,
        include: {
          users_coop_advance_payments_farmer_idTousers: {
            select: { id: true, full_name: true, phone: true },
          },
        },
        orderBy: { paid_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.coop_advance_payments.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  async getAdvancesForAnnonce(coopId: string, annonceId: string) {
    if (!coopId) throw new ForbiddenException('Compte non rattaché à une coop.');
    return this.prisma.coop_advance_payments.findMany({
      where: { cooperative_id: coopId, annonce_vente_id: annonceId },
      orderBy: { paid_at: 'desc' },
    });
  }

  // ===================================================================
  //  PUBLICATIONS COOP — CRUD direct (migré depuis marketplace)
  // ---------------------------------------------------------------------
  //  Distinct du flow d'agrégation (aggregateIntoPublication).
  //  Ici la coop publie un stock qu'elle possède déjà directement,
  //  sans passer par des annonces de membres assignées.
  // ===================================================================

  /** Liste publique des publications coop actives (lecture marketplace). */
  async listPublicationsCoop(query: ListerPublicationsCoopQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.publications_stock_coopWhereInput = {
      is_active: true,
      ...(query.produit_id && { produit_id: query.produit_id }),
      ...(query.region_id && { region_id: query.region_id }),
      ...(query.qualite && { qualite: query.qualite }),
      ...(query.cooperative_id && { cooperative_id: query.cooperative_id }),
    };

    const [data, total] = await Promise.all([
      this.prisma.publications_stock_coop.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          produits_agricoles: { select: { nom: true, unite_mesure: true } },
          cooperative_profiles: { select: { id: true, nom: true } },
          regions_ci: { select: { nom: true } },
          medias: { select: { url: true, thumbnail_url: true }, take: 5 },
        },
      }),
      this.prisma.publications_stock_coop.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  async getPublicationCoopById(id: string) {
    const publication = await this.prisma.publications_stock_coop.findUnique({
      where: { id },
      include: {
        produits_agricoles: true,
        cooperative_profiles: { select: { id: true, nom: true, numero_agrement: true } },
        regions_ci: { select: { nom: true } },
        villes_ci: { select: { nom: true } },
        medias: true,
        publication_coop_traitements: {
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
    if (!publication) throw new NotFoundException('Publication introuvable.');
    return publication;
  }

  /**
   * Crée une publication coop directe (sans agrégation). Le cooperative_id
   * est extrait du JWT (calculé par AuthService.genererTokens).
   */
  async createPublicationCoop(
    cooperativeId: string | null,
    dto: CreatePublicationCoopDto,
  ) {
    if (!cooperativeId) {
      throw new BadRequestException(
        'Compte non rattaché à une coopérative (cooperative_id absent du JWT).',
      );
    }

    const coop = await this.prisma.cooperative_profiles.findUnique({
      where: { id: cooperativeId },
    });
    if (!coop) throw new NotFoundException('Profil coopérative introuvable.');

    const { lng, lat } = dto.coordinates;

    const result = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO publications_stock_coop (
        cooperative_id, produit_id, quantite_kg, prix_par_kg, qualite,
        region_id, ville_id, location, is_active
      ) VALUES (
        ${cooperativeId}::uuid,
        ${dto.produit_id}::uuid,
        ${dto.quantite_kg},
        ${dto.prix_par_kg ?? null},
        ${dto.qualite ?? null}::product_quality,
        ${dto.region_id}::uuid,
        ${dto.ville_id}::uuid,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326),
        true
      ) RETURNING id;
    `;
    const publicationId = result[0]?.id;

    // Insère les traitements appliqués (traçabilité / certif BIO).
    // Chaque entrée accepte UUID OU nom (résolu via ILIKE).
    if (publicationId && dto.traitements?.length) {
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
            await this.prisma.publications_stock_coop.delete({
              where: { id: publicationId },
            });
            throw new BadRequestException(
              'Chaque traitement doit avoir un produit_traitement_id OU un produit_traitement_nom.',
            );
          }
          const match = await this.prisma.produits_traitement.findFirst({
            where: { nom: { contains: t.produit_traitement_nom, mode: 'insensitive' } },
            select: { id: true },
          });
          if (!match) {
            await this.prisma.publications_stock_coop.delete({
              where: { id: publicationId },
            });
            throw new BadRequestException(
              `Traitement "${t.produit_traitement_nom}" introuvable dans le catalogue.`,
            );
          }
          pid = match.id;
        } else {
          const exists = await this.prisma.produits_traitement.findUnique({
            where: { id: pid },
            select: { id: true },
          });
          if (!exists) {
            await this.prisma.publications_stock_coop.delete({
              where: { id: publicationId },
            });
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
      await this.prisma.publication_coop_traitements.createMany({
        data: resolved.map((r) => ({
          publication_id: publicationId,
          produit_traitement_id: r.id,
          dosage_utilise: r.dosage_utilise,
          date_application: r.date_application,
          delai_carence_respecte: r.delai_carence_respecte,
          notes: r.notes,
        })),
        skipDuplicates: true,
      });
    }

    return {
      message: 'Publication du stock coopératif réussie.',
      publication_id: publicationId,
      traitements_declares: dto.traitements?.length ?? 0,
    };
  }

  async updatePublicationCoop(
    cooperativeId: string | null,
    id: string,
    dto: UpdatePublicationCoopDto,
  ) {
    if (!cooperativeId) {
      throw new BadRequestException('Coopérative non identifiée dans le JWT.');
    }
    const pub = await this.prisma.publications_stock_coop.findFirst({
      where: { id, cooperative_id: cooperativeId },
    });
    if (!pub) throw new NotFoundException('Publication introuvable.');

    await this.prisma.publications_stock_coop.update({
      where: { id },
      data: {
        ...(dto.quantite_kg !== undefined && { quantite_kg: dto.quantite_kg }),
        ...(dto.prix_par_kg !== undefined && { prix_par_kg: dto.prix_par_kg }),
        ...(dto.qualite !== undefined && { qualite: dto.qualite }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });
    return { message: 'Publication modifiée.' };
  }

  async deletePublicationCoop(cooperativeId: string | null, id: string) {
    if (!cooperativeId) {
      throw new BadRequestException('Coopérative non identifiée dans le JWT.');
    }
    const pub = await this.prisma.publications_stock_coop.findFirst({
      where: { id, cooperative_id: cooperativeId },
    });
    if (!pub) throw new NotFoundException('Publication introuvable.');
    await this.prisma.publications_stock_coop.delete({ where: { id } });
    return { message: 'Publication supprimée.' };
  }

  // ===================================================================
  //  HELPERS PRIVÉS
  // ===================================================================

  /**
   * Synchronise la coop active du farmer dans les deux endroits :
   *   • users.cooperative_id           (raccourci pour les requêtes)
   *   • producteur_profiles.coop_id    (utilisé par le JWT generator)
   * Reçoit le client de transaction pour rester atomique.
   */
  private async syncFarmerCoopId(
    tx: Prisma.TransactionClient,
    farmerId: string,
    coopId: string | null,
  ): Promise<void> {
    await tx.users.update({
      where: { id: farmerId },
      data: { cooperative_id: coopId },
    });
    await tx.producteur_profiles.updateMany({
      where: { user_id: farmerId },
      data: { coop_id: coopId },
    });
  }
}
