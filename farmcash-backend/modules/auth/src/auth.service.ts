// =====================================================================
//  SERVICE : AuthService
//  ---------------------------------------------------------------------
//  Cœur métier du module d'authentification. Ce fichier contient TOUTES
//  les règles métier liées aux comptes utilisateurs : inscription, OTP,
//  PIN, JWT, rotation des refresh tokens, déconnexion, gestion du profil
//  et enregistrement des tokens FCM (notifications push mobiles).
//
//  Aucun appel HTTP ici : ce service est appelé exclusivement par le
//  AuthController. Il n'expose pas non plus de dépendances externes :
//  l'envoi de SMS est délégué au SmsProvider (cf. sms.provider.ts), ce
//  qui permet de remplacer le canal d'envoi (Twilio, Orange…) sans
//  toucher au code métier.
//
//  --------------------------------- CHOIX DE SÉCURITÉ ---------------------------------
//  • PIN utilisateur     → bcrypt rounds=12   (hash unique, non réversible).
//  • OTP SMS             → bcrypt rounds=10   (hash en base, jamais en clair).
//  • Refresh tokens      → sha256             (hash DÉTERMINISTE, recherche
//                                              par hash possible en DB).
//                          + rotation à chaque /refresh
//                          + détection de rejeu d'un token déjà révoqué
//                          → révocation de TOUTES les sessions de l'user.
//  • Account locking     → 3 tentatives PIN ratées = lock 15 minutes.
//  • Anti-énumération    → message identique pour "user inconnu" et "PIN
//                          incorrect". Hash bidon en cas d'absence pour
//                          masquer la différence de temps de réponse
//                          (timing attack).
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, user_role, users } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '@farmcash/database';
import { isWeakPin, normalizePhone, sha256 } from '@farmcash/shared';
import { InscriptionDto, SupportedLanguage } from './dto/register.dto';
import {
  ChangePinDto,
  ConnexionPinDto,
  DefinirPinDto,
  RefreshTokenDto,
} from './dto/login.dto';
import { EnvoyerOtpDto, OtpPurpose, VerifierOtpDto } from './dto/otp.dto';
import {
  AdminNiveau,
  ProfilAcheteurDto,
  ProfilAdminDto,
  ProfilCooperativeDto,
  ProfilExportateurDto,
  ProfilProducteurDto,
  ProfilTransporteurDto,
  UpdateProfileDto,
} from './dto/profile.dto';
import {
  BootstrapAdminDto,
  CreateAdminDto,
} from './dto/admin-register.dto';
import { ForbiddenException } from '@nestjs/common';
import { DeviceTokenDto } from './dto/device-token.dto';
import { SmsProvider } from './sms.provider';
import { CooperativesService } from '@farmcash/cooperatives';

// ---------- Constantes métier (faciles à ajuster) ----------
/** Nombre de tentatives PIN consécutives autorisées avant lock du compte. */
const MAX_FAILED_ATTEMPTS = 3;
/** Durée (en minutes) du lock automatique après MAX_FAILED_ATTEMPTS. */
const LOCK_TIME_MINUTES = 15;
/** Durée de validité d'un OTP envoyé par SMS (en minutes). */
const OTP_TTL_MINUTES = 10;
/** Durée de vie d'un refresh token (en jours). Au-delà : reconnexion forcée. */
const REFRESH_TTL_DAYS = 7;
/** Message UNIQUE pour toutes les erreurs d'authentification (anti-énumération). */
const GENERIC_AUTH_ERROR = 'Identifiants incorrects.';

/**
 * Type Prisma "user avec ses 3 profils étendus" calculé automatiquement
 * à partir du schema.prisma. Évite de réécrire à la main la forme du
 * payload retourné par findUnique({ include: { ... } }).
 */
type UserWithProfiles = Prisma.usersGetPayload<{
  include: {
    producteur_profiles: true;
    acheteur_profiles: true;
    cooperative_profiles: true;
    transporteur_profiles: true;
    exportateur_profiles: true;
    admin_profiles: true;
  };
}>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sms: SmsProvider,
    @Inject(forwardRef(() => CooperativesService))
    private readonly cooperativesService: CooperativesService,
  ) {}

  /**
   * Endpoint de santé du module — utilisé par le monitoring/orchestrateur
   * pour vérifier que le service est vivant.
   */
  ping() {
    return { module: 'auth', status: 'ok' };
  }

  // ===================================================================
  //  INSCRIPTION
  // ===================================================================

  /**
   * Crée un nouveau compte utilisateur de manière ATOMIQUE.
   *
   * Étapes :
   *   1. Normalise le numéro au format E.164 (+225...) avec libphonenumber-js.
   *   2. Ouvre une transaction Prisma → garantit que TOUT réussit ou
   *      RIEN n'est créé (un user sans profil n'existera jamais).
   *   3. Vérifie qu'aucun compte n'existe déjà pour ce phone (et email).
   *   4. Crée la ligne `users`.
   *   5. Crée la ligne de profil étendu correspondant au rôle
   *      (producteur_profiles, acheteur_profiles ou cooperative_profiles).
   *
   * Note race condition : sans transaction, deux requêtes simultanées
   * peuvent passer le findUnique en même temps puis tenter create →
   * une des deux pète. Avec la transaction, on garantit la sérialisation.
   */
  async inscrire(dto: InscriptionDto) {
    const phone = normalizePhone(dto.phone);
    if (!phone) {
      throw new BadRequestException('Numéro de téléphone invalide.');
    }

    // Garde-fou défensif. Le DTO retire déjà ADMIN de l'enum public,
    // mais on revérifie au cas où un payload bypasserait la validation.
    if ((dto.role as user_role) === 'ADMIN') {
      throw new ForbiddenException(
        'Le rôle ADMIN ne peut pas être créé via /auth/register. ' +
          'Utiliser /auth/admin/register (SUPER_ADMIN) ou /auth/admin/bootstrap.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Vérifications de doublon (phone obligatoire, email optionnel).
      // Exécutées en parallèle pour gagner un round-trip DB.
      const [existPhone, existEmail] = await Promise.all([
        tx.users.findUnique({ where: { phone } }),
        dto.email
          ? tx.users.findUnique({ where: { email: dto.email } })
          : Promise.resolve(null),
      ]);

      if (existPhone) {
        throw new ConflictException('Ce numéro de téléphone est déjà enregistré.');
      }
      if (existEmail) {
        throw new ConflictException('Cette adresse email est déjà utilisée.');
      }

      // Création du compte principal.
      const user = await tx.users.create({
        data: {
          phone,
          full_name: dto.full_name,
          email: dto.email ?? null,
          role: dto.role as user_role,
          langue: dto.langue ?? SupportedLanguage.FR,
        },
      });

      // Création du profil étendu lié au rôle (FARMER, BUYER, COOPERATIVE).
      await this.creerProfilRole(tx, user.id, dto.role);

      // On retourne le minimum nécessaire : le front-end n'a pas besoin de
      // tout le user, juste l'id et le numéro confirmé.
      return {
        message: 'Compte créé avec succès.',
        user_id: user.id,
        phone: user.phone,
      };
    }).then(async (res) => {
      // Si FARMER + default_cooperative_id fourni → délègue à
      // CooperativesService.createJoinRequest qui appartient au bon
      // domaine métier. Hors transaction (l'inscription est déjà
      // committée). Une erreur ici (coop introuvable, etc.) ne fait
      // PAS échouer l'inscription : on log et on continue.
      if (dto.role === 'FARMER' && dto.default_cooperative_id) {
        try {
          await this.cooperativesService.createJoinRequest(res.user_id, {
            cooperative_id: dto.default_cooperative_id,
            message: "Demande déclenchée à l'inscription.",
          });
        } catch (e: any) {
          this.logger.warn(
            `Join-request à l'inscription échouée (${e?.message}) — l'utilisateur peut renvoyer la demande plus tard.`,
          );
        }
      }
      return res;
    });
  }

  // ===================================================================
  //  CONNEXION PAR PIN
  // ===================================================================

  /**
   * Connecte un utilisateur via son numéro + son code PIN.
   *
   * Sécurité — étapes :
   *   1. Lookup user par phone. Si introuvable OU pas de PIN défini :
   *      on hash quand même un PIN bidon (bcrypt.compare avec un sel
   *      invalide) pour ne pas révéler par le temps de réponse si le
   *      compte existe. Message d'erreur GÉNÉRIQUE (anti-énumération).
   *   2. Si le compte est désactivé → refus immédiat.
   *   3. Si lock actif (locked_until > now) → indique le temps restant.
   *   4. Compare le PIN. Si KO → incrémente failed_attempts ;
   *      au seuil, applique le lock.
   *   5. Si OK → reset les compteurs, met à jour last_login,
   *      et émet le couple access + refresh tokens.
   */
  async connexionPin(dto: ConnexionPinDto) {
    const user = await this.findUserWithProfiles({ phone: dto.phone });

    // Anti-énumération : on simule un bcrypt.compare même si le user n'existe
    // pas, pour que le temps de réponse soit identique aux deux cas.
    if (!user || !user.pin_hash) {
      await bcrypt.compare(dto.pin, '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsa');
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Compte désactivé. Contactez le support.');
    }

    // Profil géré par une coop → pas d'authentification directe.
    // Si phone=null, on n'arrive jamais ici (lookup par phone), mais on
    // garde le garde-fou pour les cas tordus (phone restauré post-promotion
    // mais managed_by_coop_id non nettoyé, ou attaque qui pousse un PIN).
    this.assertNotManagedProfile(user);

    // Lock encore actif → on bloque sans même tester le PIN.
    if (user.locked_until && user.locked_until > new Date()) {
      const remaining = Math.ceil(
        (user.locked_until.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Compte temporairement bloqué. Réessayez dans ${remaining} minute(s).`,
      );
    }

    const ok = await bcrypt.compare(dto.pin, user.pin_hash);
    if (!ok) {
      await this.registerFailedAttempt(user);
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    // Login OK → on remet à zéro les compteurs et on date la connexion.
    await this.prisma.users.update({
      where: { id: user.id },
      data: {
        failed_attempts: 0,
        locked_until: null,
        last_login: new Date(),
      },
    });

    return this.genererTokens(user);
  }

  // ===================================================================
  //  OTP (One-Time Password par SMS)
  // ===================================================================

  /**
   * Génère un code à 6 chiffres, le hash en base, et délègue l'envoi
   * physique au SmsProvider.
   *
   * Détail important :
   *   • On invalide d'abord les OTP précédents (même purpose) pour ne
   *     laisser qu'UN seul code actif à la fois → simplifie la vérif.
   *   • Le code en clair n'est JAMAIS stocké ; seul son hash bcrypt.
   *   • En production, SmsProvider lève une erreur s'il n'est pas câblé
   *     à un vrai backend (Twilio / Orange CI) → impossible d'oublier
   *     silencieusement de brancher l'envoi.
   */
  async envoyerOtp(dto: EnvoyerOtpDto) {
    // Garde-fou « farmer géré par coop » : si un user existe avec ce
    // phone et qu'il a `managed_by_coop_id` non-NULL, on refuse l'OTP
    // (pas d'authentification directe possible). En pratique le
    // managed user n'a PAS de phone — mais on couvre le cas où le
    // numéro a été restauré sans nettoyer le flag (sécurité défensive).
    const existingUser = await this.prisma.users.findUnique({
      where: { phone: dto.phone },
      select: { managed_by_coop_id: true, phone: true },
    });
    if (existingUser?.managed_by_coop_id) {
      throw new ForbiddenException(
        "Ce profil est géré par une coopérative — pas d'authentification directe. Demandez à votre coop de vous promouvoir en compte autonome.",
      );
    }

    // Invalidation des OTP précédents non utilisés (purpose identique).
    await this.prisma.otps.updateMany({
      where: { phone: dto.phone, purpose: dto.purpose, is_used: false },
      data: { is_used: true },
    });

    // Génération du code à 6 chiffres (100000..999999).
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

    await this.prisma.otps.create({
      data: {
        phone: dto.phone,
        code_hash: codeHash,
        purpose: dto.purpose,
        expires_at: expiresAt,
      },
    });

    await this.sms.sendOtp(dto.phone, code);

    return { message: `Code envoyé au ${dto.phone}.` };
  }

  /**
   * Valide un OTP soumis par l'utilisateur. Si correct :
   *   1. Marque l'OTP comme utilisé (à usage unique).
   *   2. Marque le user comme `is_verified` (= téléphone vérifié).
   *   3. Émet les tokens d'authentification.
   *
   * Note sur `is_verified` : ce flag indique uniquement que le numéro
   * a été prouvé par OTP. Le KYC documentaire (CNI, RCCM…) est traité
   * séparément via la table `user_documents`.
   */
  async verifierOtp(dto: VerifierOtpDto) {
    // On prend le plus récent OTP non utilisé et non expiré.
    const otp = await this.prisma.otps.findFirst({
      where: {
        phone: dto.phone,
        purpose: dto.purpose,
        is_used: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!otp) {
      throw new BadRequestException('Code OTP invalide ou expiré.');
    }

    const ok = await bcrypt.compare(dto.code, otp.code_hash);
    if (!ok) {
      throw new BadRequestException('Code incorrect.');
    }

    // Consommation : un OTP ne sert qu'une fois.
    await this.prisma.otps.update({
      where: { id: otp.id },
      data: { is_used: true },
    });

    const user = await this.findUserWithProfiles({ phone: dto.phone });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    if (!user.is_active) {
      throw new UnauthorizedException('Compte désactivé. Contactez le support.');
    }

    // Profil géré par une coop → pas de tokens émis (cf. envoyerOtp).
    this.assertNotManagedProfile(user);

    await this.prisma.users.update({
      where: { id: user.id },
      data: { is_verified: true, last_login: new Date() },
    });

    return this.genererTokens(user);
  }

  // ===================================================================
  //  REFRESH TOKEN (rotation + détection de rejeu)
  // ===================================================================

  /**
   * Échange un refresh_token valide contre un nouveau couple (access +
   * refresh). À chaque appel, l'ancien refresh est révoqué : c'est le
   * pattern dit "rotation".
   *
   * Détection de rejeu : si quelqu'un présente un token DÉJÀ révoqué,
   * c'est un signe fort de compromission (token volé, l'attaquant utilise
   * la version révoquée pendant que le vrai user a déjà tourné). On
   * révoque alors TOUTES les sessions actives du user pour le couper net
   * → reconnexion forcée par OTP/PIN.
   */
  async refresh(dto: RefreshTokenDto) {
    const tokenHash = sha256(dto.refresh_token);

    const stored = await this.prisma.refresh_tokens.findUnique({
      where: { token_hash: tokenHash },
    });

    // Rejeu d'un token déjà révoqué = signal d'alarme.
    if (stored?.revoked_at) {
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.user_id} — revoking all sessions`,
      );
      await this.prisma.refresh_tokens.updateMany({
        where: { user_id: stored.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      throw new UnauthorizedException('Session compromise détectée. Reconnectez-vous.');
    }

    if (!stored || stored.expires_at < new Date()) {
      throw new UnauthorizedException('Refresh token invalide ou expiré.');
    }

    const user = await this.findUserWithProfiles({ id: stored.user_id });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('Compte introuvable ou désactivé.');
    }

    // Rotation : on révoque l'ancien AVANT d'émettre le nouveau.
    await this.prisma.refresh_tokens.update({
      where: { id: stored.id },
      data: { revoked_at: new Date() },
    });

    return this.genererTokens(user);
  }

  // ===================================================================
  //  LOGOUT
  // ===================================================================

  /**
   * Déconnexion d'une ou de toutes les sessions.
   *
   * @param userId         L'utilisateur authentifié (issu du JWT).
   * @param refreshTokenBrut Si fourni : révoque uniquement CE token
   *                       (déconnexion de l'appareil courant).
   *                       Si absent : révoque TOUS les refresh tokens
   *                       non encore révoqués → déconnexion de tous
   *                       les appareils ("global logout").
   */
  async logout(userId: string, refreshTokenBrut?: string) {
    if (refreshTokenBrut) {
      const tokenHash = sha256(refreshTokenBrut);
      await this.prisma.refresh_tokens.updateMany({
        where: { token_hash: tokenHash, user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    } else {
      await this.prisma.refresh_tokens.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
    return { message: 'Déconnexion effectuée.' };
  }

  // ===================================================================
  //  GESTION DU PIN
  // ===================================================================

  /**
   * Définit le code PIN d'un utilisateur (typiquement après inscription
   * + vérification OTP). Vérifie que :
   *   • Les deux saisies correspondent.
   *   • Le PIN n'est pas dans la blacklist (cf. isWeakPin) :
   *       - chiffres identiques (1111, 0000…)
   *       - séquences (1234, 6789…)
   *       - PIN connus comme triviaux (top des leaks publics).
   *
   * Le PIN est hashé avec bcrypt rounds=12 (coût plus élevé que celui
   * appliqué aux OTP, car le PIN est censé durer plus longtemps).
   */
  async definirPin(userId: string, dto: DefinirPinDto) {
    if (dto.pin !== dto.pin_confirm) {
      throw new BadRequestException('Les deux PIN ne correspondent pas.');
    }
    if (isWeakPin(dto.pin)) {
      throw new BadRequestException(
        'PIN trop faible (séquence, chiffres identiques ou PIN commun).',
      );
    }
    const pinHash = await bcrypt.hash(dto.pin, 12);
    await this.prisma.users.update({
      where: { id: userId },
      data: { pin_hash: pinHash },
    });
    return { message: 'PIN défini avec succès.' };
  }

  /**
   * Change un PIN existant. Demande l'ancien PIN comme preuve de
   * légitimité (même si la requête est authentifiée par JWT).
   *
   * SÉCURITÉ : après changement, on révoque TOUTES les autres sessions
   * (refresh tokens) du user. Si un attaquant a volé un access token,
   * il ne pourra plus se renouveler — la vraie personne doit se
   * reconnecter, mais c'est le prix de la sécurité.
   */
  async changerPin(userId: string, dto: ChangePinDto) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user || !user.pin_hash) {
      throw new UnauthorizedException('Utilisateur introuvable.');
    }

    const ok = await bcrypt.compare(dto.old_pin, user.pin_hash);
    if (!ok) {
      throw new BadRequestException("L'ancien PIN est incorrect.");
    }
    if (dto.new_pin !== dto.new_pin_confirm) {
      throw new BadRequestException('Les nouveaux PIN ne correspondent pas.');
    }
    if (isWeakPin(dto.new_pin)) {
      throw new BadRequestException(
        'PIN trop faible (séquence, chiffres identiques ou PIN commun).',
      );
    }
    if (dto.old_pin === dto.new_pin) {
      throw new BadRequestException("Le nouveau PIN doit être différent de l'ancien.");
    }

    const newPinHash = await bcrypt.hash(dto.new_pin, 12);
    await this.prisma.users.update({
      where: { id: userId },
      data: { pin_hash: newPinHash },
    });

    // Coupe toutes les sessions précédentes : changer son PIN doit
    // forcer une reconnexion partout.
    await this.prisma.refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    return { message: 'PIN modifié avec succès. Sessions précédentes révoquées.' };
  }

  // ===================================================================
  //  PROFIL UTILISATEUR
  // ===================================================================

  /**
   * Met à jour les informations de base du profil (nom, email, photo,
   * langue). Seuls les champs explicitement fournis sont modifiés —
   * pas de surécriture partielle accidentelle des champs non envoyés.
   *
   * Le `pin_hash` est exclu de la réponse de manière systématique.
   */
  async modifierProfil(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.users.update({
      where: { id: userId },
      data: {
        // Le pattern "...(condition && { ... })" évite d'écraser avec
        // undefined les champs que l'appelant n'a pas envoyés.
        ...(dto.full_name !== undefined && { full_name: dto.full_name }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.photo_url !== undefined && { photo_url: dto.photo_url }),
        ...(dto.langue !== undefined && { langue: dto.langue }),
      },
    });
    const { pin_hash, ...safe } = user;
    void pin_hash;
    return safe;
  }

  /**
   * Met à jour le profil étendu PRODUCTEUR.
   *
   * Garde-fou : rejette si l'utilisateur n'a pas le rôle FARMER. Le
   * profil a déjà été créé (vide) lors de l'inscription, on fait donc
   * un `update` simple ; l'`upsert` reste une sécurité au cas où le
   * profil aurait été supprimé manuellement.
   */
  async modifierProfilProducteur(userId: string, dto: ProfilProducteurDto) {
    await this.assertRole(userId, 'FARMER');
    const profile = await this.prisma.producteur_profiles.upsert({
      where: { user_id: userId },
      update: {
        ...(dto.region_id !== undefined && { region_id: dto.region_id }),
        ...(dto.ville_id !== undefined && { ville_id: dto.ville_id }),
        ...(dto.village_libre !== undefined && { village_libre: dto.village_libre }),
        ...(dto.superficie_ha !== undefined && { superficie_ha: dto.superficie_ha }),
        ...(dto.nb_annees_exp !== undefined && { nb_annees_exp: dto.nb_annees_exp }),
        ...(dto.cultures_principales !== undefined && {
          cultures_principales: dto.cultures_principales,
        }),
        ...(dto.est_membre_coop !== undefined && {
          est_membre_coop: dto.est_membre_coop,
        }),
        ...(dto.coop_id !== undefined && { coop_id: dto.coop_id }),
      },
      create: {
        user_id: userId,
        region_id: dto.region_id,
        ville_id: dto.ville_id,
        village_libre: dto.village_libre,
        superficie_ha: dto.superficie_ha,
        nb_annees_exp: dto.nb_annees_exp,
        cultures_principales: dto.cultures_principales ?? [],
        est_membre_coop: dto.est_membre_coop,
        coop_id: dto.coop_id,
      },
    });
    return profile;
  }

  /**
   * Met à jour le profil étendu ACHETEUR. Réservé au rôle BUYER.
   */
  async modifierProfilAcheteur(userId: string, dto: ProfilAcheteurDto) {
    await this.assertRole(userId, 'BUYER');
    const profile = await this.prisma.acheteur_profiles.upsert({
      where: { user_id: userId },
      update: {
        ...(dto.company_name !== undefined && { company_name: dto.company_name }),
        ...(dto.numero_rccm !== undefined && { numero_rccm: dto.numero_rccm }),
        ...(dto.capacite_achat_kg !== undefined && {
          capacite_achat_kg: dto.capacite_achat_kg,
        }),
        ...(dto.zones_achat !== undefined && { zones_achat: dto.zones_achat }),
      },
      create: {
        user_id: userId,
        company_name: dto.company_name,
        numero_rccm: dto.numero_rccm,
        capacite_achat_kg: dto.capacite_achat_kg,
        zones_achat: dto.zones_achat ?? [],
      },
    });
    return profile;
  }

  /**
   * Met à jour le profil étendu COOPÉRATIVE. Réservé au rôle COOPERATIVE.
   * `nom` est obligatoire en DB (NOT NULL) — on conserve la valeur
   * existante si elle n'est pas fournie.
   */
  async modifierProfilCooperative(userId: string, dto: ProfilCooperativeDto) {
    await this.assertRole(userId, 'COOPERATIVE');
    const existing = await this.prisma.cooperative_profiles.findUnique({
      where: { user_id: userId },
    });
    const profile = await this.prisma.cooperative_profiles.upsert({
      where: { user_id: userId },
      update: {
        ...(dto.nom !== undefined && { nom: dto.nom }),
        ...(dto.numero_agrement !== undefined && {
          numero_agrement: dto.numero_agrement,
        }),
        ...(dto.region_id !== undefined && { region_id: dto.region_id }),
        ...(dto.ville_id !== undefined && { ville_id: dto.ville_id }),
        ...(dto.produits !== undefined && { produits: dto.produits }),
      },
      create: {
        user_id: userId,
        nom: dto.nom ?? existing?.nom ?? 'Ma coopérative',
        numero_agrement: dto.numero_agrement,
        region_id: dto.region_id,
        ville_id: dto.ville_id,
        produits: dto.produits ?? [],
      },
    });
    return profile;
  }

  /**
   * Met à jour le profil étendu TRANSPORTEUR. Réservé au rôle TRANSPORTER.
   *
   * Contrainte : si le profil n'existe pas encore (premier onboarding),
   * les 4 champs obligatoires en DB doivent être TOUS fournis (numero_permis,
   * type_vehicule, immatriculation, capacite_max_kg). Sinon on PATCH.
   *
   * `immatriculation` est UNIQUE en DB → un mauvais doublon retourne 409.
   */
  async modifierProfilTransporteur(userId: string, dto: ProfilTransporteurDto) {
    await this.assertRole(userId, 'TRANSPORTER');

    const existing = await this.prisma.transporteur_profiles.findUnique({
      where: { user_id: userId },
    });

    // Premier onboarding : on impose les 4 champs NOT NULL
    if (!existing) {
      const missing: string[] = [];
      if (!dto.numero_permis) missing.push('numero_permis');
      if (!dto.type_vehicule) missing.push('type_vehicule');
      if (!dto.immatriculation) missing.push('immatriculation');
      if (dto.capacite_max_kg === undefined || dto.capacite_max_kg === null) {
        missing.push('capacite_max_kg');
      }
      if (missing.length > 0) {
        throw new BadRequestException(
          `Premier onboarding transporteur : champs requis manquants : ${missing.join(', ')}.`,
        );
      }
    }

    // NB : on n'utilise PAS upsert ici car Prisma valide la payload `create`
    // de manière stricte côté client (les champs requis ne peuvent pas être
    // undefined), même quand la branche `update` est celle qui sera exécutée.
    // On split donc en update / create explicites.
    try {
      if (existing) {
        return await this.prisma.transporteur_profiles.update({
          where: { user_id: userId },
          data: {
            ...(dto.nom_entreprise !== undefined && { nom_entreprise: dto.nom_entreprise }),
            ...(dto.numero_rccm !== undefined && { numero_rccm: dto.numero_rccm }),
            ...(dto.numero_ifu !== undefined && { numero_ifu: dto.numero_ifu }),
            ...(dto.numero_permis !== undefined && { numero_permis: dto.numero_permis }),
            ...(dto.categorie_permis !== undefined && { categorie_permis: dto.categorie_permis }),
            ...(dto.type_vehicule !== undefined && { type_vehicule: dto.type_vehicule }),
            ...(dto.immatriculation !== undefined && { immatriculation: dto.immatriculation }),
            ...(dto.marque_modele !== undefined && { marque_modele: dto.marque_modele }),
            ...(dto.annee_vehicule !== undefined && { annee_vehicule: dto.annee_vehicule }),
            ...(dto.capacite_max_kg !== undefined && { capacite_max_kg: dto.capacite_max_kg }),
            ...(dto.volume_max_m3 !== undefined && { volume_max_m3: dto.volume_max_m3 }),
            ...(dto.is_refrigere !== undefined && { is_refrigere: dto.is_refrigere }),
            ...(dto.is_bache !== undefined && { is_bache: dto.is_bache }),
            ...(dto.region_id !== undefined && { region_id: dto.region_id }),
            ...(dto.ville_id !== undefined && { ville_id: dto.ville_id }),
            ...(dto.zones_couvertes !== undefined && { zones_couvertes: dto.zones_couvertes }),
            ...(dto.rayon_action_km !== undefined && { rayon_action_km: dto.rayon_action_km }),
            ...(dto.tarif_kg_default !== undefined && { tarif_kg_default: dto.tarif_kg_default }),
            ...(dto.tarif_minimum_default !== undefined && {
              tarif_minimum_default: dto.tarif_minimum_default,
            }),
            ...(dto.disponible !== undefined && { disponible: dto.disponible }),
          },
        });
      }

      // Premier onboarding : les 4 champs requis ont été vérifiés plus haut
      return await this.prisma.transporteur_profiles.create({
        data: {
          user_id: userId,
          nom_entreprise: dto.nom_entreprise,
          numero_rccm: dto.numero_rccm,
          numero_ifu: dto.numero_ifu,
          numero_permis: dto.numero_permis!,
          categorie_permis: dto.categorie_permis,
          type_vehicule: dto.type_vehicule!,
          immatriculation: dto.immatriculation!,
          marque_modele: dto.marque_modele,
          annee_vehicule: dto.annee_vehicule,
          capacite_max_kg: dto.capacite_max_kg!,
          volume_max_m3: dto.volume_max_m3,
          is_refrigere: dto.is_refrigere ?? false,
          is_bache: dto.is_bache ?? false,
          region_id: dto.region_id,
          ville_id: dto.ville_id,
          zones_couvertes: dto.zones_couvertes ?? [],
          rayon_action_km: dto.rayon_action_km,
          tarif_kg_default: dto.tarif_kg_default,
          tarif_minimum_default: dto.tarif_minimum_default,
          disponible: dto.disponible ?? true,
        },
      });
    } catch (e) {
      // Doublon d'immatriculation
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Cette immatriculation est déjà associée à un autre transporteur.',
        );
      }
      throw e;
    }
  }

  /**
   * Met à jour le profil étendu EXPORTATEUR. Réservé au rôle EXPORTER.
   * Tous les champs sont optionnels (profil créé vide à l'inscription).
   */
  async modifierProfilExportateur(userId: string, dto: ProfilExportateurDto) {
    await this.assertRole(userId, 'EXPORTER');
    const profile = await this.prisma.exportateur_profiles.upsert({
      where: { user_id: userId },
      update: {
        ...(dto.company_name !== undefined && { company_name: dto.company_name }),
        ...(dto.numero_rccm !== undefined && { numero_rccm: dto.numero_rccm }),
        ...(dto.numero_ifu !== undefined && { numero_ifu: dto.numero_ifu }),
        ...(dto.agrement_export !== undefined && { agrement_export: dto.agrement_export }),
        ...(dto.produits_exportes !== undefined && {
          produits_exportes: dto.produits_exportes,
        }),
        ...(dto.pays_destination !== undefined && {
          pays_destination: dto.pays_destination,
        }),
        ...(dto.incoterms_supportes !== undefined && {
          incoterms_supportes: dto.incoterms_supportes,
        }),
        ...(dto.port_attache !== undefined && { port_attache: dto.port_attache }),
        ...(dto.volume_annuel_kg !== undefined && { volume_annuel_kg: dto.volume_annuel_kg }),
        ...(dto.iban !== undefined && { iban: dto.iban }),
        ...(dto.swift_bic !== undefined && { swift_bic: dto.swift_bic }),
      },
      create: {
        user_id: userId,
        company_name: dto.company_name,
        numero_rccm: dto.numero_rccm,
        numero_ifu: dto.numero_ifu,
        agrement_export: dto.agrement_export,
        produits_exportes: dto.produits_exportes ?? [],
        pays_destination: dto.pays_destination ?? [],
        incoterms_supportes: dto.incoterms_supportes ?? [],
        port_attache: dto.port_attache,
        volume_annuel_kg: dto.volume_annuel_kg,
        iban: dto.iban,
        swift_bic: dto.swift_bic,
      },
    });
    return profile;
  }

  /**
   * Met à jour le profil étendu ADMIN. Réservé au rôle ADMIN.
   *
   * RÈGLE SÉCURITÉ FORTE :
   *   - Les champs `niveau` et les permissions `peut_*` ne peuvent
   *     être modifiés QUE par un SUPER_ADMIN (sur lui-même OU un autre).
   *   - Un admin non super peut éditer ses propres `departement` et `notes`,
   *     mais pas s'auto-promouvoir.
   *   - On vérifie le niveau de l'appelant en chargeant son propre profil.
   */
  async modifierProfilAdmin(userId: string, dto: ProfilAdminDto) {
    await this.assertRole(userId, 'ADMIN');

    const callerProfile = await this.prisma.admin_profiles.findUnique({
      where: { user_id: userId },
    });
    const isSuperAdmin = callerProfile?.niveau === 'SUPER_ADMIN';

    const tryingToEscalate =
      dto.niveau !== undefined ||
      dto.peut_valider_kyc !== undefined ||
      dto.peut_gerer_finance !== undefined ||
      dto.peut_gerer_users !== undefined ||
      dto.peut_publier_news !== undefined;

    if (tryingToEscalate && !isSuperAdmin) {
      throw new ForbiddenException(
        'Seul un SUPER_ADMIN peut modifier le niveau ou les permissions.',
      );
    }

    const profile = await this.prisma.admin_profiles.upsert({
      where: { user_id: userId },
      update: {
        ...(dto.niveau !== undefined && { niveau: dto.niveau }),
        ...(dto.departement !== undefined && { departement: dto.departement }),
        ...(dto.peut_valider_kyc !== undefined && {
          peut_valider_kyc: dto.peut_valider_kyc,
        }),
        ...(dto.peut_gerer_finance !== undefined && {
          peut_gerer_finance: dto.peut_gerer_finance,
        }),
        ...(dto.peut_gerer_users !== undefined && {
          peut_gerer_users: dto.peut_gerer_users,
        }),
        ...(dto.peut_publier_news !== undefined && {
          peut_publier_news: dto.peut_publier_news,
        }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
      create: {
        user_id: userId,
        niveau: dto.niveau,
        departement: dto.departement,
        peut_valider_kyc: dto.peut_valider_kyc ?? false,
        peut_gerer_finance: dto.peut_gerer_finance ?? false,
        peut_gerer_users: dto.peut_gerer_users ?? false,
        peut_publier_news: dto.peut_publier_news ?? false,
        notes: dto.notes,
      },
    });
    return profile;
  }

  // ===================================================================
  //  CRÉATION DE COMPTES ADMIN (chemins dédiés)
  // ===================================================================

  /**
   * POST /auth/admin/register — un SUPER_ADMIN crée un nouvel admin.
   *
   * Sécurité :
   *   1. L'appelant doit avoir role=ADMIN (guard) ET niveau=SUPER_ADMIN
   *      (vérifié ici en chargeant son admin_profiles).
   *   2. Transaction : user + admin_profiles ensemble.
   *   3. Aucune permission n'est attribuée par défaut — le SUPER_ADMIN
   *      doit explicitement les activer dans le DTO.
   */
  async creerAdmin(callerId: string, dto: CreateAdminDto) {
    // 1. Vérifier que l'appelant est SUPER_ADMIN
    const caller = await this.prisma.users.findUnique({
      where: { id: callerId },
      include: { admin_profiles: true },
    });
    if (!caller || caller.role !== 'ADMIN') {
      throw new ForbiddenException('Réservé au rôle ADMIN.');
    }
    if (caller.admin_profiles?.niveau !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Seul un SUPER_ADMIN peut créer un autre compte admin.',
      );
    }

    // 2. Normalisation phone + dédup
    const phone = normalizePhone(dto.phone);
    if (!phone) {
      throw new BadRequestException('Numéro de téléphone invalide.');
    }

    return this.prisma.$transaction(async (tx) => {
      const [existPhone, existEmail] = await Promise.all([
        tx.users.findUnique({ where: { phone } }),
        dto.email
          ? tx.users.findUnique({ where: { email: dto.email } })
          : Promise.resolve(null),
      ]);
      if (existPhone) {
        throw new ConflictException('Ce numéro est déjà enregistré.');
      }
      if (existEmail) {
        throw new ConflictException('Cette adresse email est déjà utilisée.');
      }

      const user = await tx.users.create({
        data: {
          phone,
          full_name: dto.full_name,
          email: dto.email ?? null,
          role: 'ADMIN',
          langue: dto.langue ?? SupportedLanguage.FR,
        },
      });

      await tx.admin_profiles.create({
        data: {
          user_id: user.id,
          niveau: (dto.niveau as AdminNiveau) ?? AdminNiveau.ADMIN,
          departement: dto.departement,
          peut_valider_kyc: dto.peut_valider_kyc ?? false,
          peut_gerer_finance: dto.peut_gerer_finance ?? false,
          peut_gerer_users: dto.peut_gerer_users ?? false,
          peut_publier_news: dto.peut_publier_news ?? false,
        },
      });

      return {
        message: 'Compte admin créé.',
        user_id: user.id,
        phone: user.phone,
        niveau: dto.niveau ?? 'ADMIN',
      };
    });
  }

  /**
   * POST /auth/admin/bootstrap — crée le PREMIER super-admin.
   *
   * Conditions strictes :
   *   1. Le header X-Bootstrap-Token doit matcher BOOTSTRAP_ADMIN_TOKEN
   *      configuré côté serveur (env). Sinon 403.
   *   2. La table `users` ne doit contenir AUCUN admin existant. Sinon
   *      403 — utiliser /auth/admin/register à la place.
   *
   * Le compte créé est automatiquement SUPER_ADMIN avec toutes les
   * permissions à TRUE (sinon on aurait un super-admin sans pouvoirs).
   */
  async bootstrapAdmin(dto: BootstrapAdminDto, providedToken: string | undefined) {
    const expectedToken = this.config.get<string>('BOOTSTRAP_ADMIN_TOKEN');
    if (!expectedToken) {
      throw new ForbiddenException(
        'Bootstrap admin désactivé (BOOTSTRAP_ADMIN_TOKEN non configuré).',
      );
    }
    if (!providedToken || providedToken !== expectedToken) {
      throw new ForbiddenException('Token de bootstrap invalide.');
    }

    const phone = normalizePhone(dto.phone);
    if (!phone) {
      throw new BadRequestException('Numéro de téléphone invalide.');
    }

    return this.prisma.$transaction(async (tx) => {
      // Garde absolue : la route n'est ouverte que si la DB n'a aucun admin
      const adminCount = await tx.users.count({ where: { role: 'ADMIN' } });
      if (adminCount > 0) {
        throw new ForbiddenException(
          'Un admin existe déjà — utiliser /auth/admin/register à la place.',
        );
      }

      const [existPhone, existEmail] = await Promise.all([
        tx.users.findUnique({ where: { phone } }),
        dto.email
          ? tx.users.findUnique({ where: { email: dto.email } })
          : Promise.resolve(null),
      ]);
      if (existPhone) {
        throw new ConflictException('Ce numéro est déjà enregistré.');
      }
      if (existEmail) {
        throw new ConflictException('Cette adresse email est déjà utilisée.');
      }

      const user = await tx.users.create({
        data: {
          phone,
          full_name: dto.full_name,
          email: dto.email ?? null,
          role: 'ADMIN',
          langue: dto.langue ?? SupportedLanguage.FR,
        },
      });

      // Le bootstrap force SUPER_ADMIN + toutes permissions à true.
      await tx.admin_profiles.create({
        data: {
          user_id: user.id,
          niveau: AdminNiveau.SUPER_ADMIN,
          peut_valider_kyc: true,
          peut_gerer_finance: true,
          peut_gerer_users: true,
          peut_publier_news: true,
          notes: 'Compte de bootstrap initial.',
        },
      });

      this.logger.warn(
        `🚨 Bootstrap admin exécuté pour user=${user.id} (${phone}). ` +
          `Rotate BOOTSTRAP_ADMIN_TOKEN après cette opération.`,
      );

      return {
        message: 'Compte SUPER_ADMIN initial créé.',
        user_id: user.id,
        phone: user.phone,
        niveau: 'SUPER_ADMIN',
      };
    });
  }

  /**
   * Garde-fou : rejette toute tentative d'authentification d'un compte
   * marqué comme « géré par une coop » (managed_by_coop_id non-NULL).
   *
   * Ces comptes n'ont pas de téléphone ni de PIN — la coop publie/vend
   * en leur nom. La promotion en compte autonome se fait via
   * POST /coop/members/:id/promote.
   */
  private assertNotManagedProfile(user: { managed_by_coop_id?: string | null }): void {
    if (user.managed_by_coop_id) {
      throw new ForbiddenException(
        "Ce profil est géré par une coopérative — pas d'authentification directe. Demandez à votre coop de vous promouvoir en compte autonome.",
      );
    }
  }

  /**
   * Vérifie que l'utilisateur a le rôle attendu avant toute mise à jour
   * d'un profil étendu. Évite qu'un BUYER puisse écrire dans
   * `producteur_profiles`.
   */
  private async assertRole(userId: string, expected: user_role): Promise<void> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    if (user.role !== expected) {
      throw new ForbiddenException(
        `Action réservée aux comptes ${expected}. Rôle actuel : ${user.role}.`,
      );
    }
  }

  /**
   * Récupère le profil complet de l'utilisateur connecté, avec ses
   * 3 profils étendus (FARMER / BUYER / COOPERATIVE). Les profils non
   * pertinents pour le rôle reviennent `null` — c'est le front qui
   * décide quoi afficher selon `role`.
   *
   * `pin_hash` est TOUJOURS exclu de la réponse (sécurité).
   */
  async monProfil(userId: string) {
    const user = await this.findUserWithProfiles({ id: userId });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const { pin_hash, ...safe } = user;
    void pin_hash;
    return safe;
  }

  /**
   * Enregistre (ou réactive) un token FCM Firebase pour l'envoi de
   * notifications push mobiles. Utilise un upsert sur la clé composite
   * (user_id, fcm_token) → idempotent : si l'app renvoie le même
   * token au prochain démarrage, on ne crée pas de doublon.
   */
  async enregistrerDeviceToken(userId: string, dto: DeviceTokenDto) {
    await this.prisma.device_tokens.upsert({
      where: {
        user_id_fcm_token: { user_id: userId, fcm_token: dto.fcm_token },
      },
      update: { is_active: true, platform: dto.platform },
      create: { user_id: userId, fcm_token: dto.fcm_token, platform: dto.platform },
    });
    return { message: 'Token device enregistré.' };
  }

  // ===================================================================
  //  MÉTHODES PRIVÉES (helpers internes au service)
  // ===================================================================

  /**
   * Helper qui retourne un user avec ses 3 profils étendus.
   * Centralise l'`include` Prisma pour éviter la divergence entre
   * les différentes méthodes du service.
   */
  private async findUserWithProfiles(
    where: Prisma.usersWhereUniqueInput,
  ): Promise<UserWithProfiles | null> {
    return this.prisma.users.findUnique({
      where,
      include: {
        producteur_profiles: true,
        acheteur_profiles: true,
        cooperative_profiles: true,
        transporteur_profiles: true,
        exportateur_profiles: true,
        admin_profiles: true,
      },
    });
  }

  /**
   * Incrémente le compteur failed_attempts. Si on atteint le seuil,
   * pose un lock de LOCK_TIME_MINUTES et remet le compteur à zéro
   * (on aura donc 3 nouvelles tentatives une fois le lock expiré).
   */
  private async registerFailedAttempt(user: users): Promise<void> {
    const attempts = user.failed_attempts + 1;
    const data: Prisma.usersUpdateInput = { failed_attempts: attempts };
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      data.locked_until = new Date(Date.now() + LOCK_TIME_MINUTES * 60_000);
      data.failed_attempts = 0;
    }
    await this.prisma.users.update({ where: { id: user.id }, data });
  }

  /**
   * Génère un couple (access_token, refresh_token) pour un user donné.
   *
   *   • access_token  : JWT signé par JWT_SECRET, expire en JWT_EXPIRES_IN
   *                     (15 minutes par défaut). Contient sub, role,
   *                     phone, cooperative_id → utilisable directement
   *                     par les autres modules pour le contrôle d'accès.
   *   • refresh_token : 64 bytes aléatoires (512 bits d'entropie),
   *                     stockés en DB sous forme de hash sha256 pour
   *                     pouvoir les retrouver lors du /refresh.
   *                     Durée 7 jours par défaut.
   */
  private async genererTokens(user: UserWithProfiles) {
    // cooperative_id n'est pertinent que pour FARMER (rattaché à une coop)
    // et COOPERATIVE (son propre id de coop).
    const cooperativeId =
      user.role === 'FARMER'
        ? user.producteur_profiles?.coop_id ?? null
        : user.role === 'COOPERATIVE'
          ? user.cooperative_profiles?.id ?? null
          : null;

    const payload = {
      sub: user.id,
      role: user.role,
      phone: user.phone,
      cooperative_id: cooperativeId,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: (this.config.get<string>('JWT_EXPIRES_IN') ?? '15m') as any,
    });

    // Refresh token : la valeur brute est retournée UNE SEULE FOIS au
    // client. On ne stocke que son hash → en cas de fuite DB, l'attaquant
    // ne peut pas réutiliser les tokens.
    const refreshBrut = randomBytes(64).toString('hex');
    const refreshHash = sha256(refreshBrut);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

    await this.prisma.refresh_tokens.create({
      data: {
        user_id: user.id,
        token_hash: refreshHash,
        expires_at: expiresAt,
      },
    });

    return {
      access_token: accessToken,
      refresh_token: refreshBrut,
      token_type: 'Bearer',
      user: {
        id: user.id,
        full_name: user.full_name,
        role: user.role,
        cooperative_id: cooperativeId,
      },
    };
  }

  /**
   * Crée la ligne de profil étendu adaptée au rôle. Reçoit le client de
   * transaction (`tx`) plutôt que `this.prisma` pour rester dans la
   * même transaction que la création du user (atomicité — cf. inscrire).
   */
  private async creerProfilRole(
    tx: Prisma.TransactionClient,
    userId: string,
    role: user_role,
  ): Promise<void> {
    switch (role) {
      case 'FARMER':
        await tx.producteur_profiles.create({ data: { user_id: userId } });
        break;
      case 'BUYER':
        await tx.acheteur_profiles.create({ data: { user_id: userId } });
        break;
      case 'COOPERATIVE':
        await tx.cooperative_profiles.create({
          data: { user_id: userId, nom: 'Ma coopérative' },
        });
        break;
      case 'EXPORTER':
        await tx.exportateur_profiles.create({ data: { user_id: userId } });
        break;
      case 'ADMIN':
        // Niveau par défaut 'ADMIN' avec aucune permission peut_*.
        // Un SUPER_ADMIN devra promouvoir manuellement.
        await tx.admin_profiles.create({ data: { user_id: userId } });
        break;
      case 'TRANSPORTER':
        // Pas de profil créé ici : la table transporteur_profiles
        // requiert numero_permis, immatriculation, type_vehicule,
        // capacite_max_kg (NOT NULL). Le transporteur doit compléter
        // son onboarding via POST /auth/profile/transporteur avant
        // tout usage opérationnel.
        break;
    }
  }
}
