import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AllExceptionsFilter,
  TransformInterceptor,
  RequestLoggerInterceptor,
  MaskingInterceptor,
  MaskingService,
  TwilioProxyService,
} from '@farmcash/shared';
import { PrismaModule } from '@farmcash/database';
import { AuthModule } from '@farmcash/auth';
import { MarketplaceModule } from '@farmcash/marketplace';
import { NegotiationModule } from '@farmcash/negotiation';
import { OrdersModule } from '@farmcash/orders';
import { FinanceModule } from '@farmcash/finance';
import { LogisticsModule } from '@farmcash/logistics';
import { MessagingModule } from '@farmcash/messaging';
import { NotificationsModule } from '@farmcash/notifications';
import { AiModule } from '@farmcash/ai';
import { OversightModule } from '@farmcash/oversight';
import { CooperativesModule } from '@farmcash/cooperatives';
import { BuyerModule } from '@farmcash/buyer';
import { CoopLogisticsModule } from '@farmcash/coop-logistics';

@Module({
  imports: [
    // Variables d'environnement disponibles partout via ConfigService
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),

    // Rate limiting global (60 req/min/IP par défaut) — peut être surchargé
    // par @Throttle({...}) sur un endpoint, ou @SkipThrottle() pour bypasser.
    // En tests E2E (DISABLE_THROTTLE=true), on bypass complètement.
    ThrottlerModule.forRoot(
      process.env.DISABLE_THROTTLE === 'true'
        ? [{ name: 'default', limit: 1_000_000, ttl: 1_000 }]
        : [{ name: 'default', limit: 60, ttl: 60_000 }],
    ),

    // Base de données Prisma — @Global() donc disponible dans tous les modules
    PrismaModule,

    // Modules métier
    AuthModule,
    MarketplaceModule,
    NegotiationModule,
    OrdersModule,
    FinanceModule,
    LogisticsModule,
    MessagingModule,
    NotificationsModule,
    AiModule,
    OversightModule,
    CooperativesModule,
    BuyerModule,
    CoopLogisticsModule,
  ],
  providers: [
    // Rate limiting global (premier guard exécuté). Désactivé en E2E.
    ...(process.env.DISABLE_THROTTLE === 'true'
      ? []
      : [{ provide: APP_GUARD, useClass: ThrottlerGuard }]),
    // Filter global avec DI (mapping Prisma → HTTP)
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Logger HTTP + correlation ID — doit s'exécuter avant Transform
    { provide: APP_INTERCEPTOR, useClass: RequestLoggerInterceptor },
    // Anti-contournement (Chantier 3) — DOIT être enregistré AVANT
    // TransformInterceptor pour masker le payload métier brut (et non
    // l'enveloppe {success, data, timestamp}). MaskingService injecté.
    // TwilioProxyService (chantier 5.a) est injecté optionnellement dans
    // MaskingService pour fournir un vrai numéro proxy en visibilité
    // PARTIAL (commande active).
    TwilioProxyService,
    MaskingService,
    { provide: APP_INTERCEPTOR, useClass: MaskingInterceptor },
    // Wrapping {success, data, timestamp}
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
