// =====================================================================
//  MODULE : MessagingModule
//  ---------------------------------------------------------------------
//  Importe NotificationsModule (pour notifier les autres participants
//  lors d'un nouveau message) et JwtModule (déjà global via AuthModule,
//  utilisé par MessagingGateway pour vérifier le token au handshake).
// =====================================================================

import { Module } from '@nestjs/common';
import { NotificationsModule } from '@farmcash/notifications';
import { MaskingService, TwilioProxyService } from '@farmcash/shared';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MessagingGateway } from './messaging.gateway';
import { PhoneProxyController } from './phone-proxy.controller';
import { PhoneProxyService } from './phone-proxy.service';

@Module({
  imports: [NotificationsModule],
  controllers: [MessagingController, PhoneProxyController],
  providers: [
    MessagingService,
    MessagingGateway,
    // Chantier 5.a — Phone proxy.
    // MaskingService et TwilioProxyService sont fournis au niveau de
    // l'AppModule, mais on les re-déclare ici pour permettre l'injection
    // locale dans PhoneProxyService sans dépendre de l'ordre des imports.
    MaskingService,
    TwilioProxyService,
    PhoneProxyService,
  ],
  exports: [MessagingService, PhoneProxyService],
})
export class MessagingModule {}
