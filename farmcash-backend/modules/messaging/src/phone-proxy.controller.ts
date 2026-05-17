// =====================================================================
//  CONTROLLER : PhoneProxyController (Chantier 5.a)
//  ---------------------------------------------------------------------
//  Deux endpoints :
//
//   POST /api/messaging/phone-proxy
//     → Allocation d'un numéro proxy pour appeler un autre user.
//        Auth : JWT obligatoire.
//
//   POST /api/messaging/phone-proxy/webhook
//     → Webhook Twilio (call.completed, etc.). Public (auth par signature
//        HMAC Twilio en prod, à câbler avec un guard dédié). En MVP, on
//        accepte le body brut et on enregistre les compteurs.
// =====================================================================

import {
  Body,
  Controller,
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
import { AuthenticatedUser, CurrentUser, SkipMasking } from '@farmcash/shared';
import { JwtAuthGuard } from '@farmcash/auth';
import { PhoneProxyService } from './phone-proxy.service';
import {
  CreateProxyCallDto,
  ProxyCallResponseDto,
  TwilioWebhookDto,
} from './dto/phone-proxy.dto';

@ApiTags('📞 Phone Proxy')
@Controller('messaging/phone-proxy')
export class PhoneProxyController {
  constructor(private readonly phoneProxyService: PhoneProxyService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @SkipMasking() // La réponse contient un numéro proxy déjà sûr — pas de PII à masquer.
  @ApiOperation({
    summary: 'Demander un numéro proxy pour appeler un autre utilisateur',
    description:
      'Réutilise une session active si possible (TTL 14j). Refuse si pas de ' +
      'relation business (commande, livraison, même coop) entre caller et callee.',
  })
  @ApiResponse({ status: 201, type: ProxyCallResponseDto })
  @ApiResponse({ status: 403, description: 'Pas de relation justifiant un appel.' })
  @ApiResponse({ status: 404, description: 'Callee introuvable.' })
  createProxyCall(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProxyCallDto,
  ): Promise<ProxyCallResponseDto> {
    return this.phoneProxyService.createProxyCall(user.sub, user.role, dto);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @SkipMasking()
  @ApiOperation({
    summary: 'Webhook Twilio (call.completed, etc.)',
    description:
      'Mis à jour des compteurs (call_count, total_duration_sec) pour QA et ' +
      'facturation. La signature HMAC Twilio sera validée par un guard dédié ' +
      'en prod (X-Twilio-Signature).',
  })
  @ApiResponse({ status: 200, description: 'Événement reçu et traité.' })
  handleWebhook(@Body() dto: TwilioWebhookDto) {
    return this.phoneProxyService.handleWebhook(dto);
  }
}
