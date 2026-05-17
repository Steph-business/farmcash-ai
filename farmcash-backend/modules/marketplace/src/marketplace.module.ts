// =====================================================================
//  MODULE : MarketplaceModule
//  ---------------------------------------------------------------------
//  Le marketplace est volumineux : on l'a découpé en 6 sous-controllers
//  + 6 sous-services pour garder chaque fichier lisible. Tous tournent
//  sous le même @Module — donc DB connection, guards et providers
//  partagés.
//
//  Composition :
//   • Marketplace    : annonces de vente/achat, publications coop, catalogue.
//   • Panier         : panier d'achat (BUYER, COOPERATIVE).
//   • Stock          : entrepôts + lots.
//   • Agronomie      : parcelles + cultures.
//   • Interactions   : favoris, avis, médias.
//   • Previsions     : prévisions de récolte + réservations futures.
//
//  Tous les services métier sont exportés → utilisables par les modules
//  voisins (Negotiation, Orders…) qui peuvent injecter par exemple
//  MarketplaceService pour relire une annonce.
// =====================================================================

import { forwardRef, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CooperativesModule } from '@farmcash/cooperatives';
import { FinanceModule } from '@farmcash/finance';
import { StorageService } from '@farmcash/shared';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { PanierController } from './panier.controller';
import { PanierService } from './panier.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { AgronomieController } from './agronomie.controller';
import { AgronomieService } from './agronomie.service';
import { InteractionsController } from './interactions.controller';
import { InteractionsService } from './interactions.service';
import { PrevisionsController } from './previsions.controller';
import { PrevisionsService } from './previsions.service';
import { ReservationsExpirationCron } from './reservations-expiration.cron';
import { PrevisionsReminderCron } from './previsions-reminder.cron';

@Module({
  imports: [
    // Marketplace délègue à Cooperatives :
    //  • createAnnonceVente → attachAnnonceToCoop (workflow validation)
    // forwardRef par prudence (cooperatives utilise notifications, qui
    // peut indirectement transiter par auth).
    forwardRef(() => CooperativesModule),
    // PrevisionsService utilise FinanceService pour les acomptes 10%
    // et les forfait/refund à l'expiration.
    forwardRef(() => FinanceModule),
    // Multer en mémoire — le fichier est immédiatement reposté vers MinIO
    // par StorageService, pas besoin de fichier temporaire sur disque.
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  ],
  controllers: [
    MarketplaceController,
    PanierController,
    StockController,
    AgronomieController,
    InteractionsController,
    PrevisionsController,
  ],
  providers: [
    MarketplaceService,
    PanierService,
    StockService,
    AgronomieService,
    InteractionsService,
    PrevisionsService,
    ReservationsExpirationCron,
    // Chantier 5.b — rappel J-5 avant la date prévue de récolte.
    PrevisionsReminderCron,
    StorageService,
  ],
  exports: [
    MarketplaceService,
    PanierService,
    StockService,
    AgronomieService,
    InteractionsService,
    PrevisionsService,
  ],
})
export class MarketplaceModule {}
