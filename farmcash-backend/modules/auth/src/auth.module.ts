// =====================================================================
//  MODULE : AuthModule
//  ---------------------------------------------------------------------
//  Déclare le module d'authentification au sens NestJS : controller,
//  service, providers (SmsProvider), guards, et configuration JwtModule.
//
//  Le JwtModule est enregistré en mode "global" → toute l'application
//  peut injecter JwtService sans ré-importer ce module ailleurs. Cela
//  permet aux autres modules (Marketplace, Finance…) de vérifier des
//  tokens via le même JwtAuthGuard.
//
//  Le secret JWT est lu depuis la config (ConfigService) au démarrage.
//  S'il est absent OU trop court (< 32 caractères), on lève une erreur
//  fatale : il est impossible de booter l'application avec un secret
//  faible. C'est une protection contre les déploiements mal configurés
//  qui sinon utiliseraient une valeur par défaut prévisible.
// =====================================================================

import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SmsProvider } from './sms.provider';
import {
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  RolesGuard,
} from './guards/jwt.guard';
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import { CooperativesModule } from '@farmcash/cooperatives';

@Module({
  imports: [
    // Configuration JwtModule via factory asynchrone : permet d'aller
    // chercher le secret dans ConfigService au boot de l'application.
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          // Crash fatal : on refuse de démarrer un service auth avec un
          // secret manquant ou prévisible. Pas de fallback "dev" possible.
          throw new Error(
            'JWT_SECRET missing or too short (min 32 chars). Refusing to boot.',
          );
        }
        return {
          secret,
          signOptions: {
            // Le cast `as any` contourne un typage strict de @nestjs/jwt
            // v11 qui attend un literal type "15m" | "1h" issu de ms.
            expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '15m') as any,
          },
        };
      },
    }),
    // Permet à AuthService de déléguer la création de join-request au
    // module Cooperatives. forwardRef pour casser le cycle :
    // auth → cooperatives → notifications → (JwtAuthGuard de auth).
    forwardRef(() => CooperativesModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService, // logique métier
    SmsProvider, // abstraction de l'envoi SMS
    JwtAuthGuard, // protection des routes par JWT
    OptionalJwtAuthGuard, // variante "best-effort" pour routes publiques
    RolesGuard,   // contrôle de rôle (cf. @Roles(...))
    AdminPermissionGuard, // contrôle fin des permissions admin (cf. @AdminPermission(...))
  ],
  exports: [
    // Tout ce qui est exporté ici peut être utilisé par les autres
    // modules. JwtAuthGuard et RolesGuard sont les plus consommés
    // (Marketplace, Finance, etc. s'en servent pour protéger leurs routes).
    AuthService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
    AdminPermissionGuard,
    JwtModule,
    // SmsProvider est ré-exporté pour les modules métier qui font du
    // fan-out SMS best-effort (ex : Cooperatives → sollicitations).
    SmsProvider,
  ],
})
export class AuthModule {}
