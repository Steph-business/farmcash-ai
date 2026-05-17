// =====================================================================
//  PROVIDER : SmsProvider
//  ---------------------------------------------------------------------
//  Abstraction de l'envoi de SMS. AuthService ne dépend que de cette
//  interface, jamais directement d'un fournisseur particulier (Twilio,
//  Orange CI, Africa's Talking…).
//
//  Avantage : le jour où on change de provider SMS (ou qu'on en utilise
//  plusieurs selon le pays), il suffit de modifier ce fichier sans
//  toucher au code métier.
//
//  Comportement actuel :
//   • En développement (NODE_ENV ≠ 'production') : on n'envoie PAS de
//     vrai SMS, on log le code en DEBUG → l'équipe peut tester le flow
//     OTP sans dépenser de crédit SMS.
//   • En production : on LÈVE une erreur tant qu'aucun provider n'a été
//     branché. Cela évite la situation où on déploie l'app en pensant
//     que les SMS partent alors qu'ils ne partent pas (échec silencieux).
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SmsProvider {
  private readonly logger = new Logger(SmsProvider.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Envoie (ou simule l'envoi) d'un code OTP par SMS.
   *
   * @param phone  Numéro destinataire au format E.164 (+225...)
   * @param code   Code à 6 chiffres généré par AuthService
   */
  async sendOtp(phone: string, code: string): Promise<void> {
    const env = this.config.get<string>('NODE_ENV') ?? 'development';

    if (env !== 'production') {
      // En dev : on log le code en niveau DEBUG. Visible dans la console
      // du backend mais pas en environnement de prod.
      this.logger.debug(`[DEV] OTP for ${phone}: ${code}`);
      return;
    }

    // TODO : brancher un vrai provider SMS pour la production.
    //        Exemple Twilio : await this.twilio.messages.create({ ... })
    //        Exemple Orange CI : appel REST à l'API Orange Senegal/CI.
    throw new Error(
      'SmsProvider: no production SMS backend configured. Wire Twilio/Orange.',
    );
  }

  /**
   * Envoi générique de SMS (notifications transactionnelles, alertes,
   * fan-out coop, etc.). Même politique dev/prod que `sendOtp` :
   *   • En dev : log only (best effort).
   *   • En prod : lève une erreur tant qu'aucun backend SMS n'est câblé,
   *     pour éviter les échecs silencieux. Le caller doit catcher cette
   *     erreur s'il considère le SMS comme best-effort.
   *
   * @param phone  Numéro destinataire au format E.164 (+225...)
   * @param text   Corps du SMS (truncate côté caller si > 160 char)
   */
  async send(phone: string, text: string): Promise<void> {
    const env = this.config.get<string>('NODE_ENV') ?? 'development';

    if (env !== 'production') {
      this.logger.debug(`[DEV] SMS to ${phone}: ${text}`);
      return;
    }

    // TODO : brancher un vrai provider SMS pour la production.
    throw new Error(
      'SmsProvider: no production SMS backend configured. Wire Twilio/Orange.',
    );
  }
}
