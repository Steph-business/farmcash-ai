// =====================================================================
//  PaymentWebhookController
//  ---------------------------------------------------------------------
//  Reçoit les callbacks asynchrones des providers Mobile Money.
//  En prod : Orange CI / MTN MoMo / Wave appellent cette URL après
//  un PAYIN ou PAYOUT pour signaler le statut final.
//  En dev   : MockPaymentProvider l'appelle via setTimeout.
//
//  Sécurité (à compléter quand on aura les vrais providers) :
//   • Vérification de signature HMAC du payload
//   • IP allowlist par provider
//   • Idempotency par idempotency_key
// =====================================================================

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { FinanceService } from '../finance.service';

class ProviderWebhookDto {
  @IsString()
  @IsNotEmpty()
  provider: string;

  @IsString()
  @IsNotEmpty()
  provider_ref: string;

  @IsString()
  @IsNotEmpty()
  idempotency_key: string;

  @IsIn(['PENDING', 'ACCEPTED', 'REJECTED', 'FAILED', 'TIMEOUT'])
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FAILED' | 'TIMEOUT';

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsIn(['PAYIN', 'PAYOUT', 'TOPUP'])
  kind?: 'PAYIN' | 'PAYOUT' | 'TOPUP';

  @IsOptional()
  @IsString()
  timestamp?: string;
}

@ApiTags('🔔 Payment Webhooks')
@Controller('webhooks/payment-provider')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(private readonly financeService: FinanceService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Callback async d\'un provider Mobile Money' })
  async handleWebhook(
    @Param('provider') provider: string,
    @Body() payload: ProviderWebhookDto,
  ) {
    this.logger.log(
      `webhook ${provider} ref=${payload.provider_ref} status=${payload.status}`,
    );
    // Délégué au service finance qui sait quoi faire selon le contexte.
    return this.financeService.handleProviderWebhook(provider, payload);
  }
}
