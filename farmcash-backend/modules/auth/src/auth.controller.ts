// =====================================================================
//  CONTROLLER : AuthController
//  ---------------------------------------------------------------------
//  Expose les routes HTTP du module d'authentification. Le controller
//  ne contient AUCUNE logique métier : il se contente de transmettre la
//  requête (DTO validé par class-validator) au service, et de renvoyer
//  la réponse. Toute la logique vit dans AuthService.
//
//  --------- ROUTES PUBLIQUES (aucune authentification requise) ----------
//    POST /api/auth/register     → Créer un compte (FARMER, BUYER…)
//    POST /api/auth/send-otp     → Demander l'envoi d'un code SMS
//    POST /api/auth/verify-otp   → Valider le code SMS → JWT
//    POST /api/auth/login-pin    → Connexion par phone + PIN → JWT
//    POST /api/auth/refresh      → Renouveler le couple access/refresh
//    GET  /api/auth/health       → Health check du module
//
//  --------- ROUTES PRIVÉES (Bearer JWT requis) ---------------------------
//    POST /api/auth/logout         → Révoquer la session courante
//    POST /api/auth/set-pin        → Définir son code PIN
//    POST /api/auth/change-pin     → Changer son PIN (révoque toutes sessions)
//    GET  /api/auth/me             → Récupérer son profil complet
//    POST /api/auth/profile/update → Mettre à jour son profil
//    POST /api/auth/device-token   → Enregistrer un token FCM mobile
//
//  --------- RATE LIMITING (Throttler, comptage par IP) ------------------
//    register     : 5  / heure
//    send-otp     : 3  / 15 min
//    verify-otp   : 10 / 5 min
//    login-pin    : 10 / 5 min
//    refresh      : 30 / min
//    (les autres routes héritent du défaut global défini dans AppModule)
// =====================================================================

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { AuthService } from './auth.service';
import { InscriptionDto } from './dto/register.dto';
import {
  ChangePinDto,
  ConnexionPinDto,
  DefinirPinDto,
  RefreshTokenDto,
} from './dto/login.dto';
import { EnvoyerOtpDto, VerifierOtpDto } from './dto/otp.dto';
import {
  ProfilAcheteurDto,
  ProfilAdminDto,
  ProfilCooperativeDto,
  ProfilExportateurDto,
  ProfilProducteurDto,
  ProfilTransporteurDto,
  UpdateProfileDto,
} from './dto/profile.dto';
import { DeviceTokenDto } from './dto/device-token.dto';
import { JwtAuthGuard } from './guards/jwt.guard';
import {
  BootstrapAdminDto,
  CreateAdminDto,
} from './dto/admin-register.dto';

@ApiTags('🔐 Authentification')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * GET /auth/health
   * Sonde simple pour vérifier que le module est joignable.
   */
  @Get('health')
  @ApiOperation({ summary: 'Vérifie que le module auth fonctionne' })
  health() {
    return this.authService.ping();
  }

  /**
   * POST /auth/register
   * Crée un nouveau compte. Limité à 5 inscriptions par heure et par IP
   * pour empêcher le spam de comptes fantômes.
   */
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un nouveau compte FarmCash' })
  @ApiResponse({ status: 201, description: 'Compte créé' })
  @ApiResponse({ status: 409, description: 'Conflit (phone/email déjà utilisé)' })
  inscrire(@Body() dto: InscriptionDto) {
    return this.authService.inscrire(dto);
  }

  /**
   * POST /auth/admin/register
   * Création d'un compte ADMIN par un SUPER_ADMIN authentifié.
   * Le service vérifie niveau=SUPER_ADMIN avant toute opération.
   */
  @Post('admin/register')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un compte ADMIN (SUPER_ADMIN uniquement)' })
  @ApiResponse({ status: 201, description: 'Compte admin créé' })
  @ApiResponse({ status: 403, description: 'Réservé aux SUPER_ADMIN' })
  @ApiResponse({ status: 409, description: 'Conflit phone/email' })
  creerAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAdminDto,
  ) {
    return this.authService.creerAdmin(user.sub, dto);
  }

  /**
   * POST /auth/admin/bootstrap
   * Création du PREMIER super-admin de la base.
   *
   * Conditions :
   *   • Header `X-Bootstrap-Token` doit matcher BOOTSTRAP_ADMIN_TOKEN (env)
   *   • Aucun admin ne doit déjà exister en DB
   *
   * Une fois exécuté, la route restera fonctionnelle au niveau routing
   * mais retournera 403 (admin existe déjà). Rotate le token après usage.
   */
  @Post('admin/bootstrap')
  @Throttle({ default: { limit: 3, ttl: 60 * 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bootstrap : créer le 1er SUPER_ADMIN (sans aucun admin existant)',
  })
  @ApiResponse({ status: 201, description: 'SUPER_ADMIN initial créé' })
  @ApiResponse({
    status: 403,
    description: 'Token invalide OU un admin existe déjà',
  })
  bootstrapAdmin(
    @Body() dto: BootstrapAdminDto,
    @Headers('x-bootstrap-token') token: string,
  ) {
    return this.authService.bootstrapAdmin(dto, token);
  }

  /**
   * POST /auth/send-otp
   * Demande l'envoi d'un code OTP à 6 chiffres par SMS. Limité à
   * 3 demandes par tranche de 15 minutes (anti-spam SMS).
   */
  @Post('send-otp')
  @Throttle({ default: { limit: 3, ttl: 15 * 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Envoyer un code OTP par SMS' })
  envoyerOtp(@Body() dto: EnvoyerOtpDto) {
    return this.authService.envoyerOtp(dto);
  }

  /**
   * POST /auth/verify-otp
   * Vérifie le code OTP reçu et émet un couple (access_token,
   * refresh_token). Le compte est marqué comme `is_verified` (téléphone
   * prouvé) à cette occasion.
   */
  @Post('verify-otp')
  @Throttle({ default: { limit: 10, ttl: 5 * 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vérifier OTP → JWT' })
  verifierOtp(@Body() dto: VerifierOtpDto) {
    return this.authService.verifierOtp(dto);
  }

  /**
   * POST /auth/login-pin
   * Connexion classique phone + PIN. Anti-énumération : message
   * d'erreur identique pour "compte inconnu" et "PIN incorrect".
   */
  @Post('login-pin')
  @Throttle({ default: { limit: 10, ttl: 5 * 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Connexion phone + PIN → JWT' })
  connexionPin(@Body() dto: ConnexionPinDto) {
    return this.authService.connexionPin(dto);
  }

  /**
   * POST /auth/refresh
   * Échange un refresh_token contre un nouveau couple. Rotation :
   * l'ancien refresh est révoqué automatiquement.
   */
  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Échanger un refresh token contre un nouveau couple' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  /**
   * POST /auth/logout
   * Déconnexion. Si `refresh_token` est fourni dans le body → révoque
   * uniquement cette session. Sinon → révoque TOUTES les sessions du
   * user (déconnexion globale, utile en cas de doute sur la sécurité).
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Révoquer le refresh token (ou tous si non fourni)' })
  logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Partial<RefreshTokenDto>,
  ) {
    return this.authService.logout(user.sub, dto.refresh_token);
  }

  /**
   * POST /auth/set-pin
   * Définit le code PIN secret de l'utilisateur. Doit être appelé après
   * la première vérification OTP, sinon le user ne pourra pas se
   * reconnecter par PIN.
   */
  @Post('set-pin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Définir son code PIN' })
  definirPin(@CurrentUser() user: AuthenticatedUser, @Body() dto: DefinirPinDto) {
    return this.authService.definirPin(user.sub, dto);
  }

  /**
   * POST /auth/change-pin
   * Change un PIN existant (demande l'ancien comme preuve). Révoque
   * automatiquement toutes les autres sessions actives.
   */
  @Post('change-pin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Changer son PIN' })
  changePin(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePinDto) {
    return this.authService.changerPin(user.sub, dto);
  }

  /**
   * GET /auth/me
   * Retourne le profil complet de l'utilisateur connecté (avec ses
   * profils étendus FARMER/BUYER/COOPERATIVE selon le rôle). `pin_hash`
   * est toujours exclu de la réponse.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer mon profil complet' })
  monProfil(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.monProfil(user.sub);
  }

  /**
   * POST /auth/profile/update
   * Met à jour les informations de base : nom, email, photo, langue.
   * Tous les champs sont optionnels (patch partiel).
   */
  @Post('profile/update')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour les informations de base du profil' })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.modifierProfil(user.sub, dto);
  }

  /**
   * POST /auth/profile/producteur
   * Met à jour le profil étendu d'un FARMER (région, superficie, années
   * d'expérience, cultures, coopérative…). Tous les champs sont optionnels.
   * Le profil étendu a déjà été créé vide lors de l'inscription.
   */
  @Post('profile/producteur')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le profil étendu producteur' })
  @ApiResponse({ status: 200, description: 'Profil producteur mis à jour' })
  @ApiResponse({ status: 403, description: 'Réservé au rôle FARMER' })
  updateProfilProducteur(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProfilProducteurDto,
  ) {
    return this.authService.modifierProfilProducteur(user.sub, dto);
  }

  /**
   * POST /auth/profile/acheteur
   * Met à jour le profil étendu d'un BUYER (entreprise, RCCM, capacité
   * d'achat, zones géographiques).
   */
  @Post('profile/acheteur')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le profil étendu acheteur' })
  @ApiResponse({ status: 200, description: 'Profil acheteur mis à jour' })
  @ApiResponse({ status: 403, description: 'Réservé au rôle BUYER' })
  updateProfilAcheteur(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProfilAcheteurDto,
  ) {
    return this.authService.modifierProfilAcheteur(user.sub, dto);
  }

  /**
   * POST /auth/profile/cooperative
   * Met à jour le profil étendu d'une COOPÉRATIVE (nom officiel, numéro
   * d'agrément, région, ville, produits gérés).
   */
  @Post('profile/cooperative')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le profil étendu coopérative' })
  @ApiResponse({ status: 200, description: 'Profil coopérative mis à jour' })
  @ApiResponse({ status: 403, description: 'Réservé au rôle COOPERATIVE' })
  updateProfilCooperative(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProfilCooperativeDto,
  ) {
    return this.authService.modifierProfilCooperative(user.sub, dto);
  }

  /**
   * POST /auth/profile/transporteur
   * Met à jour le profil étendu d'un TRANSPORTER (permis, véhicule,
   * capacité, zones d'opération, tarifs par défaut).
   *
   * NB : au premier appel, 4 champs sont obligatoires (numero_permis,
   * type_vehicule, immatriculation, capacite_max_kg). Les appels suivants
   * acceptent un PATCH partiel.
   */
  @Post('profile/transporteur')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le profil étendu transporteur' })
  @ApiResponse({ status: 200, description: 'Profil transporteur mis à jour' })
  @ApiResponse({ status: 400, description: 'Champs requis manquants (premier onboarding)' })
  @ApiResponse({ status: 403, description: 'Réservé au rôle TRANSPORTER' })
  @ApiResponse({ status: 409, description: 'Immatriculation déjà utilisée' })
  updateProfilTransporteur(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProfilTransporteurDto,
  ) {
    return this.authService.modifierProfilTransporteur(user.sub, dto);
  }

  /**
   * POST /auth/profile/exportateur
   * Met à jour le profil étendu d'un EXPORTER (société, RCCM/IFU,
   * agrément, produits, pays cibles, incoterms, port, bancaire).
   */
  @Post('profile/exportateur')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le profil étendu exportateur' })
  @ApiResponse({ status: 200, description: 'Profil exportateur mis à jour' })
  @ApiResponse({ status: 403, description: 'Réservé au rôle EXPORTER' })
  updateProfilExportateur(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProfilExportateurDto,
  ) {
    return this.authService.modifierProfilExportateur(user.sub, dto);
  }

  /**
   * POST /auth/profile/admin
   * Met à jour le profil étendu d'un ADMIN.
   *
   * RÈGLE SÉCURITÉ : niveau et permissions `peut_*` ne peuvent être
   * modifiés QUE par un SUPER_ADMIN (sinon 403).
   */
  @Post('profile/admin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le profil étendu admin' })
  @ApiResponse({ status: 200, description: 'Profil admin mis à jour' })
  @ApiResponse({
    status: 403,
    description: 'Réservé au rôle ADMIN — niveau/permissions SUPER_ADMIN uniquement',
  })
  updateProfilAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProfilAdminDto,
  ) {
    return this.authService.modifierProfilAdmin(user.sub, dto);
  }

  /**
   * POST /auth/device-token
   * Enregistre le token FCM Firebase de l'appareil mobile pour recevoir
   * les notifications push. Appelé au démarrage de l'app après login.
   */
  @Post('device-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enregistrer le token push FCM' })
  enregistrerDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeviceTokenDto,
  ) {
    return this.authService.enregistrerDeviceToken(user.sub, dto);
  }
}
