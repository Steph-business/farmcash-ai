// =====================================================================
//  ReservationsExpirationCron
//  ---------------------------------------------------------------------
//  Expire chaque heure les réservations AWAITING_FINAL dont le délai
//  de paiement final est dépassé. Selon RESERVATION_EXPIRED_DEPOSIT_POLICY :
//   • FORFEIT_TO_FARMER (défaut) : deposit transféré au producteur
//   • REFUND_BUYER : deposit remboursé au buyer
//
//  Désactivable via DISABLE_RESERVATION_EXPIRATION=true.
// =====================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrevisionsService } from './previsions.service';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class ReservationsExpirationCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationsExpirationCron.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly previsions: PrevisionsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('DISABLE_RESERVATION_EXPIRATION') === 'true') {
      this.logger.log('Reservations expiration cron désactivé (env).');
      return;
    }
    setTimeout(() => this.runOnce(), 5 * 60 * 1000);
    this.timer = setInterval(() => this.runOnce(), HOUR_MS);
    this.logger.log('Reservations expiration cron : hourly');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce() {
    try {
      const result = await this.previsions.expireReservations();
      if (result.expired > 0) {
        this.logger.warn(
          `Réservations expirées : ${result.expired} (${result.forfeited} forfait, ${result.refunded} refund)`,
        );
      }
    } catch (e: any) {
      this.logger.error(`Reservations expiration crashed: ${e?.message}`);
    }
  }
}
