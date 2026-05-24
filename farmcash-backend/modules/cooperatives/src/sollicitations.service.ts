// =====================================================================
//  SERVICE : SollicitationsService (Chantier 2)
//  ---------------------------------------------------------------------
//  Mobilisation multi-audience par une coopérative pour répondre à une
//  offre d'achat trop grosse pour ses seuls stocks. Une sollicitation
//  fan-out une demande vers 1 à 3 audiences :
//    • MEMBRES         → producteurs membres actifs de la coop
//    • COOPS_VOISINES  → autres coops dans un rayon GPS (PostGIS)
//    • INDEPENDANTS    → FARMERs sans coop dans le rayon
//
//  Pour chaque destinataire :
//    1. Insert d'une ligne dans `sollicitation_recipients` (PENDING)
//    2. Création d'une notif in-app
//    3. Tentative d'envoi SMS HORS transaction (best-effort)
//
//  Réponse d'un destinataire :
//    • Marque sa ligne (ACCEPTED / REJECTED + qty)
//    • Recalcule les agrégats (total_responses, total_quantite_offerte)
//    • Auto-CLOSE en FULFILLED si tonnage cible atteint
//
//  Close manuel par la coop :
//    • Passe la sollicitation en CLOSED, plus aucune réponse acceptée
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService, NotificationType } from '@farmcash/notifications';
import { SmsProvider } from '@farmcash/auth';
import {
  CreateSollicitationDto,
  ListerSollicitationsQueryDto,
  RespondSollicitationDto,
  SollicitationAudience,
  SollicitationStatus,
} from './dto/sollicitations.dto';

interface RecipientCandidate {
  user_id: string;
  audience_segment: SollicitationAudience;
  cooperative_id?: string | null;
}

@Injectable()
export class SollicitationsService {
  private readonly logger = new Logger(SollicitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    // forwardRef pour casser le cycle auth ↔ cooperatives
    @Inject(forwardRef(() => SmsProvider))
    private readonly smsProvider: SmsProvider,
  ) {}

  // ===================================================================
  //  CREATION + FAN-OUT
  // ===================================================================

  async createSollicitation(userId: string, dto: CreateSollicitationDto) {
    // 1. Identifier la coopérative de ce user (le user est président)
    const coop = await this.prisma.cooperative_profiles.findUnique({
      where: { user_id: userId },
    });
    if (!coop) {
      throw new ForbiddenException(
        'Seul un compte COOPERATIVE peut créer une sollicitation.',
      );
    }

    // 2. Charger l'annonce source + vérifier qu'elle cible bien cette coop
    const annonce = await this.prisma.annonces_achat.findUnique({
      where: { id: dto.annonce_achat_id },
      include: { produits_agricoles: { select: { nom: true } } },
    });
    if (!annonce) throw new NotFoundException('Annonce d\'achat introuvable.');
    if (annonce.is_active === false) {
      throw new ConflictException('Annonce inactive — impossible de solliciter.');
    }
    if (annonce.target_audience === 'PUBLIC') {
      throw new BadRequestException(
        'Cette annonce est publique, pas de sollicitation coop utile.',
      );
    }
    if (
      annonce.target_audience === 'SPECIFIC_COOPERATIVE' &&
      annonce.target_cooperative_id !== coop.id
    ) {
      throw new ForbiddenException(
        'Annonce non ciblée sur votre coopérative.',
      );
    }

    // 3. Résoudre les destinataires en fonction des audiences cochées
    const recipients: RecipientCandidate[] = [];

    // 3.a MEMBRES (actifs uniquement)
    if (dto.audiences.includes(SollicitationAudience.MEMBRES)) {
      const members = await this.prisma.cooperative_members.findMany({
        where: { cooperative_id: coop.id, is_active: true },
        select: { member_id: true },
      });
      for (const m of members) {
        recipients.push({
          user_id: m.member_id,
          audience_segment: SollicitationAudience.MEMBRES,
          cooperative_id: coop.id,
        });
      }
    }

    const rayonMeters = (dto.rayon_km ?? 50) * 1000;

    // 3.b COOPS VOISINES (autres coops dans le rayon, basé sur location)
    if (dto.audiences.includes(SollicitationAudience.COOPS_VOISINES)) {
      const voisines = await this.prisma.$queryRaw<
        Array<{ user_id: string; coop_id: string }>
      >`
        SELECT user_id, id::text AS coop_id
        FROM cooperative_profiles
        WHERE id != ${coop.id}::uuid
          AND location IS NOT NULL
          AND ST_DWithin(
            location::geography,
            (SELECT location::geography FROM cooperative_profiles WHERE id = ${coop.id}::uuid),
            ${rayonMeters}
          )
        LIMIT 50;
      `;
      for (const v of voisines) {
        recipients.push({
          user_id: v.user_id,
          audience_segment: SollicitationAudience.COOPS_VOISINES,
          cooperative_id: v.coop_id,
        });
      }
    }

    // 3.c INDÉPENDANTS (FARMER sans coop dans le rayon)
    if (dto.audiences.includes(SollicitationAudience.INDEPENDANTS)) {
      const independants = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT u.id::text AS id
        FROM users u
        WHERE u.role = 'FARMER'
          AND u.cooperative_id IS NULL
          AND u.is_active = true
          AND u.location IS NOT NULL
          AND ST_DWithin(
            u.location::geography,
            (SELECT location::geography FROM cooperative_profiles WHERE id = ${coop.id}::uuid),
            ${rayonMeters}
          )
        LIMIT 200;
      `;
      for (const ind of independants) {
        recipients.push({
          user_id: ind.id,
          audience_segment: SollicitationAudience.INDEPENDANTS,
          cooperative_id: null,
        });
      }
    }

    // 3.d Dédupliquer par user_id (un user peut tomber dans 2 audiences)
    const dedupedMap = new Map<string, RecipientCandidate>();
    for (const r of recipients) {
      if (!dedupedMap.has(r.user_id)) dedupedMap.set(r.user_id, r);
    }
    // Exclut l'initiateur (cas dégénéré où sa propre fiche matcherait)
    dedupedMap.delete(userId);
    const dedupedRecipients = Array.from(dedupedMap.values());

    if (dedupedRecipients.length === 0) {
      throw new BadRequestException(
        'Aucun destinataire trouvé pour les audiences sélectionnées.',
      );
    }

    // 4. Création atomique : sollicitation + recipients + notifs in-app
    const expiresAt = new Date(
      Date.now() + (dto.duree_jours ?? 7) * 86_400_000,
    );
    const produitNom = annonce.produits_agricoles?.nom ?? 'produit';

    const sollicit = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sollicitations_coop.create({
        data: {
          cooperative_id: coop.id,
          annonce_achat_id: dto.annonce_achat_id,
          initiated_by: userId,
          message: dto.message,
          audiences: dto.audiences,
          rayon_km: dto.rayon_km ?? 50,
          quantite_cible_kg: annonce.quantite_kg,
          expires_at: expiresAt,
          status: SollicitationStatus.OPEN,
          total_recipients: dedupedRecipients.length,
        },
      });

      // 4.b Bulk insert recipients
      await tx.sollicitation_recipients.createMany({
        data: dedupedRecipients.map((r) => ({
          sollicitation_id: created.id,
          user_id: r.user_id,
          audience_segment: r.audience_segment,
          cooperative_id: r.cooperative_id ?? null,
        })),
      });

      // 4.c Notifs in-app — créées DANS la transaction pour cohérence
      //     (si la TX rollback, aucune notif ne reste orpheline).
      for (const r of dedupedRecipients) {
        const notif = await tx.notifications.create({
          data: {
            user_id: r.user_id,
            type: 'COOP_SOLLICITATION',
            titre: `Coop ${coop.nom} cherche du ${produitNom}`,
            body: dto.message.slice(0, 200),
            data: {
              sollicitation_id: created.id,
              annonce_achat_id: dto.annonce_achat_id,
              quantite_cible_kg: annonce.quantite_kg.toString(),
              audience_segment: r.audience_segment,
            } as Prisma.InputJsonValue,
            sent_at: new Date(),
          },
        });
        await tx.sollicitation_recipients.update({
          where: {
            sollicitation_id_user_id: {
              sollicitation_id: created.id,
              user_id: r.user_id,
            },
          },
          data: { notification_id: notif.id },
        });
      }

      return created;
    });

    // 5. SMS HORS transaction (best effort — on ne fail pas la création
    //    si le provider SMS est down ou non câblé en prod).
    // On ne sollicite QUE les users avec un téléphone (les farmers
    // gérés par coop ont phone=null → exclus du SMS).
    const phones = await this.prisma.users.findMany({
      where: {
        id: { in: dedupedRecipients.map((r) => r.user_id) },
        phone: { not: null },
      },
      select: { id: true, phone: true },
    });
    for (const u of phones) {
      // Le filtre Prisma garantit phone non-null, mais TS reste strict
      // (non_null_assertion explicite pour rassurer le compilateur).
      if (!u.phone) continue;
      try {
        await this.smsProvider.send(
          u.phone,
          `FarmCash: la coop ${coop.nom} cherche ${annonce.quantite_kg}kg de ${produitNom}. Ouvre l'app pour répondre.`,
        );
        await this.prisma.sollicitation_recipients.updateMany({
          where: { sollicitation_id: sollicit.id, user_id: u.id },
          data: { sms_sent_at: new Date() },
        });
      } catch (e: any) {
        this.logger.warn(`SMS KO user=${u.id} : ${e?.message ?? e}`);
      }
    }

    return {
      sollicitation_id: sollicit.id,
      recipients_count: {
        MEMBRES: dedupedRecipients.filter(
          (r) => r.audience_segment === SollicitationAudience.MEMBRES,
        ).length,
        COOPS_VOISINES: dedupedRecipients.filter(
          (r) => r.audience_segment === SollicitationAudience.COOPS_VOISINES,
        ).length,
        INDEPENDANTS: dedupedRecipients.filter(
          (r) => r.audience_segment === SollicitationAudience.INDEPENDANTS,
        ).length,
      },
      notifications_dispatched: dedupedRecipients.length,
    };
  }

  // ===================================================================
  //  LISTING par la coop initiatrice
  // ===================================================================

  async listForCoop(userId: string, query: ListerSollicitationsQueryDto) {
    const coop = await this.prisma.cooperative_profiles.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!coop) throw new ForbiddenException('Compte non rattaché à une coop.');

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.sollicitations_coopWhereInput = {
      cooperative_id: coop.id,
      ...(query.status && { status: query.status }),
    };
    const [data, total] = await Promise.all([
      this.prisma.sollicitations_coop.findMany({
        where,
        include: {
          annonces_achat: {
            select: {
              id: true,
              quantite_kg: true,
              prix_max_kg: true,
              date_besoin: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.sollicitations_coop.count({ where }),
    ]);
    return {
      data,
      meta: { page, limit, total, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  // ===================================================================
  //  DÉTAIL — coop initiatrice OU destinataire
  // ===================================================================

  async getById(userId: string, sollicitId: string) {
    const sollicit = await this.prisma.sollicitations_coop.findUnique({
      where: { id: sollicitId },
      include: {
        annonces_achat: {
          include: {
            produits_agricoles: { select: { id: true, nom: true } },
            users: { select: { id: true, full_name: true } },
          },
        },
        cooperative_profiles: { select: { id: true, nom: true, user_id: true } },
        sollicitation_recipients: {
          include: {
            users: { select: { id: true, full_name: true, phone: true } },
          },
          orderBy: { created_at: 'asc' },
        },
      },
    });
    if (!sollicit) throw new NotFoundException('Sollicitation introuvable.');

    // Autorisation : coop initiatrice OU destinataire de la sollicitation
    const isInitiator = sollicit.cooperative_profiles.user_id === userId;
    const isRecipient = sollicit.sollicitation_recipients.some(
      (r) => r.user_id === userId,
    );
    if (!isInitiator && !isRecipient) {
      throw new ForbiddenException(
        'Vous n\'avez pas accès à cette sollicitation.',
      );
    }

    // Marque opened_at pour le destinataire qui consulte
    if (isRecipient) {
      const myRecipient = sollicit.sollicitation_recipients.find(
        (r) => r.user_id === userId,
      );
      if (myRecipient && !myRecipient.opened_at) {
        await this.prisma.sollicitation_recipients.update({
          where: { id: myRecipient.id },
          data: { opened_at: new Date() },
        });
      }
    }

    // Agrégation responses_summary
    const accepted = sollicit.sollicitation_recipients.filter(
      (r) => r.response_action === 'ACCEPTED',
    );
    const rejected = sollicit.sollicitation_recipients.filter(
      (r) => r.response_action === 'REJECTED',
    );
    const pending = sollicit.sollicitation_recipients.filter(
      (r) => !r.responded_at,
    );

    return {
      sollicitation: {
        id: sollicit.id,
        cooperative_id: sollicit.cooperative_id,
        annonce_achat_id: sollicit.annonce_achat_id,
        message: sollicit.message,
        audiences: sollicit.audiences,
        rayon_km: sollicit.rayon_km,
        quantite_cible_kg: sollicit.quantite_cible_kg
          ? Number(sollicit.quantite_cible_kg)
          : null,
        expires_at: sollicit.expires_at,
        status: sollicit.status,
        total_recipients: sollicit.total_recipients ?? 0,
        total_responses: sollicit.total_responses ?? 0,
        total_quantite_offerte: Number(sollicit.total_quantite_offerte ?? 0),
        created_at: sollicit.created_at,
        annonce: sollicit.annonces_achat,
        cooperative: {
          id: sollicit.cooperative_profiles.id,
          nom: sollicit.cooperative_profiles.nom,
        },
      },
      recipients: isInitiator
        ? sollicit.sollicitation_recipients.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            audience_segment: r.audience_segment,
            cooperative_id: r.cooperative_id,
            sms_sent_at: r.sms_sent_at,
            opened_at: r.opened_at,
            responded_at: r.responded_at,
            response_action: r.response_action,
            response_quantite_kg: r.response_quantite_kg
              ? Number(r.response_quantite_kg)
              : null,
            user: r.users,
          }))
        : undefined, // les destinataires ne voient pas la liste complète
      responses_summary: {
        accepted: accepted.length,
        rejected: rejected.length,
        pending: pending.length,
        total_quantite_offerte: Number(sollicit.total_quantite_offerte ?? 0),
      },
    };
  }

  // ===================================================================
  //  RÉPONSE d'un destinataire (FARMER ou COOP voisine)
  // ===================================================================

  async respond(
    userId: string,
    sollicitId: string,
    dto: RespondSollicitationDto,
  ) {
    const recipient = await this.prisma.sollicitation_recipients.findUnique({
      where: {
        sollicitation_id_user_id: {
          sollicitation_id: sollicitId,
          user_id: userId,
        },
      },
      include: { sollicitations_coop: true },
    });
    if (!recipient) {
      throw new ForbiddenException(
        'Vous n\'êtes pas destinataire de cette sollicitation.',
      );
    }
    if (recipient.responded_at) {
      throw new ConflictException('Vous avez déjà répondu à cette sollicitation.');
    }
    if (recipient.sollicitations_coop.status !== SollicitationStatus.OPEN) {
      throw new ConflictException(
        `Sollicitation déjà ${recipient.sollicitations_coop.status}.`,
      );
    }
    if (recipient.sollicitations_coop.expires_at < new Date()) {
      throw new GoneException('Sollicitation expirée.');
    }
    if (dto.action === 'ACCEPTED' && !dto.quantite_kg) {
      throw new BadRequestException('quantite_kg requis si action=ACCEPTED.');
    }

    const txResult = await this.prisma.$transaction(async (tx) => {
      // 1. Update la ligne destinataire
      await tx.sollicitation_recipients.update({
        where: { id: recipient.id },
        data: {
          responded_at: new Date(),
          response_action: dto.action,
          response_quantite_kg:
            dto.action === 'ACCEPTED' ? dto.quantite_kg : null,
        },
      });

      // 2. Incrémente les agrégats sur la sollicitation
      if (dto.action === 'ACCEPTED') {
        await tx.sollicitations_coop.update({
          where: { id: sollicitId },
          data: {
            total_responses: { increment: 1 },
            total_quantite_offerte: { increment: dto.quantite_kg ?? 0 },
            updated_at: new Date(),
          },
        });
      } else {
        await tx.sollicitations_coop.update({
          where: { id: sollicitId },
          data: {
            total_responses: { increment: 1 },
            updated_at: new Date(),
          },
        });
      }

      // 3. Auto-FULFILLED si tonnage cible atteint
      const refreshed = await tx.sollicitations_coop.findUnique({
        where: { id: sollicitId },
      });
      let autoFulfilled = false;
      if (
        refreshed &&
        refreshed.status === SollicitationStatus.OPEN &&
        refreshed.quantite_cible_kg &&
        refreshed.total_quantite_offerte &&
        new Prisma.Decimal(refreshed.total_quantite_offerte).gte(
          new Prisma.Decimal(refreshed.quantite_cible_kg),
        )
      ) {
        await tx.sollicitations_coop.update({
          where: { id: sollicitId },
          data: { status: SollicitationStatus.FULFILLED },
        });
        await tx.notifications.create({
          data: {
            user_id: refreshed.initiated_by,
            type: 'COOP_SOLLICITATION_FULFILLED',
            titre: 'Tonnage atteint',
            body: `Votre sollicitation a réuni ${refreshed.total_quantite_offerte} kg.`,
            data: {
              sollicitation_id: sollicitId,
            } as Prisma.InputJsonValue,
            sent_at: new Date(),
          },
        });
        autoFulfilled = true;
      }

      return {
        recipient_id: recipient.id,
        response_action: dto.action,
        response_quantite_kg: dto.action === 'ACCEPTED' ? dto.quantite_kg : null,
        sollicitation_status: autoFulfilled
          ? SollicitationStatus.FULFILLED
          : refreshed?.status ?? SollicitationStatus.OPEN,
      };
    });

    // 4. Notifier la coop INITIATRICE à chaque réponse (best-effort).
    //    Le initiated_by est le user_id du compte coop qui a créé la
    //    sollicitation. On récupère aussi le nom du répondant pour
    //    enrichir le body.
    try {
      const responder = await this.prisma.users.findUnique({
        where: { id: userId },
        select: { full_name: true, phone: true },
      });
      const responderName =
        responder?.full_name?.trim() || responder?.phone || 'Un membre';
      const body =
        dto.action === 'ACCEPTED'
          ? `${responderName} propose ${dto.quantite_kg ?? 0} kg.`
          : `${responderName} a décliné la sollicitation.`;
      await this.notifications.create({
        user_id: recipient.sollicitations_coop.initiated_by,
        type: NotificationType.COOP_SOLLICITATION_RESPONSE,
        titre: 'Nouvelle réponse reçue',
        body,
        data: {
          sollicitation_id: sollicitId,
          recipient_id: recipient.id,
          response_action: dto.action,
          response_quantite_kg:
            dto.action === 'ACCEPTED' ? dto.quantite_kg : null,
          responder_id: userId,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Notif COOP_SOLLICITATION_RESPONSE KO sollicit=${sollicitId}: ${(err as Error).message}`,
      );
    }

    return txResult;
  }

  // ===================================================================
  //  CONFIRMATION par la coop initiatrice d'une réponse ACCEPTED
  //  ---------------------------------------------------------------------
  //  Une fois qu'un destinataire a répondu ACCEPTED, la coop doit
  //  contractualiser l'engagement : on bascule la ligne destinataire en
  //  CONFIRMED_BY_COOP avec un timestamp et on notifie l'engagé.
  // ===================================================================

  async acceptRecipientResponse(
    userId: string,
    sollicitId: string,
    recipientId: string,
  ) {
    // 1. Charger la sollicitation et vérifier que userId est l'initiatrice
    const sollicit = await this.prisma.sollicitations_coop.findUnique({
      where: { id: sollicitId },
      include: {
        cooperative_profiles: { select: { id: true, user_id: true, nom: true } },
      },
    });
    if (!sollicit) throw new NotFoundException('Sollicitation introuvable.');
    if (sollicit.cooperative_profiles.user_id !== userId) {
      throw new ForbiddenException(
        "Seule la coop initiatrice peut confirmer une réponse.",
      );
    }

    // 2. Charger la ligne destinataire et vérifier qu'elle appartient bien
    //    à la sollicitation + qu'elle a accepté (et pas encore confirmée).
    const recipient = await this.prisma.sollicitation_recipients.findUnique({
      where: { id: recipientId },
    });
    if (!recipient || recipient.sollicitation_id !== sollicitId) {
      throw new NotFoundException('Destinataire introuvable pour cette sollicitation.');
    }
    if (recipient.response_action !== 'ACCEPTED') {
      throw new BadRequestException(
        `Impossible de confirmer : réponse actuelle = ${recipient.response_action ?? 'NONE'}.`,
      );
    }
    if (recipient.confirmed_by_coop_at) {
      throw new ConflictException('Engagement déjà confirmé par la coop.');
    }

    // 3. Update + notification dans une transaction
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.sollicitation_recipients.update({
        where: { id: recipientId },
        data: {
          response_action: 'CONFIRMED_BY_COOP',
          confirmed_by_coop_at: new Date(),
        },
      });
      await tx.notifications.create({
        data: {
          user_id: recipient.user_id,
          type: 'COOP_SOLLICITATION_CONFIRMED',
          titre: 'Engagement confirmé',
          body: `${sollicit.cooperative_profiles.nom} a confirmé votre engagement.`,
          data: {
            sollicitation_id: sollicitId,
            recipient_id: recipientId,
          } as Prisma.InputJsonValue,
          sent_at: new Date(),
        },
      });
      return result;
    });

    this.logger.log(
      `Sollicitation ${sollicitId} : engagement recipient=${recipientId} CONFIRMED_BY_COOP par user=${userId}`,
    );

    return updated;
  }

  // ===================================================================
  //  CLOSE manuel par la coop initiatrice
  // ===================================================================

  async close(userId: string, sollicitId: string) {
    const sollicit = await this.prisma.sollicitations_coop.findUnique({
      where: { id: sollicitId },
      include: {
        cooperative_profiles: { select: { user_id: true, nom: true } },
      },
    });
    if (!sollicit) throw new NotFoundException('Sollicitation introuvable.');
    if (sollicit.cooperative_profiles.user_id !== userId) {
      throw new ForbiddenException(
        'Seule la coop initiatrice peut fermer la sollicitation.',
      );
    }
    if (sollicit.status !== SollicitationStatus.OPEN) {
      throw new ConflictException(
        `Sollicitation déjà ${sollicit.status} — fermeture impossible.`,
      );
    }

    const closed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.sollicitations_coop.update({
        where: { id: sollicitId },
        data: {
          status: SollicitationStatus.CLOSED,
          updated_at: new Date(),
        },
      });

      // Notifie les destinataires PENDING que la sollicitation est fermée
      const pending = await tx.sollicitation_recipients.findMany({
        where: {
          sollicitation_id: sollicitId,
          responded_at: null,
        },
        select: { user_id: true },
      });
      for (const p of pending) {
        await tx.notifications.create({
          data: {
            user_id: p.user_id,
            type: 'COOP_SOLLICITATION_CLOSED',
            titre: 'Sollicitation fermée',
            body: `${sollicit.cooperative_profiles.nom} a clôturé sa sollicitation.`,
            data: {
              sollicitation_id: sollicitId,
            } as Prisma.InputJsonValue,
            sent_at: new Date(),
          },
        });
      }
      return updated;
    });

    return { status: closed.status };
  }
}
