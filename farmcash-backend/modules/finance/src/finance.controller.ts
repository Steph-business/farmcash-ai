// =====================================================================
//  CONTROLLER : FinanceController
//  ---------------------------------------------------------------------
//  Surface API publique du module Finance.
//
//  Routes :
//    GET  /finance/wallet                       → solde + transactions paginées
//    POST /finance/confirm-delivery             → BUYER libère l'escrow
//    POST /finance/payout                       → retrait Mobile Money
//    POST /finance/wallet/topup                 → recharge wallet (idempotente)
//    GET  /finance/wallet/topup/:transactionId  → statut d'une recharge
//    POST /finance/release-escrow               → ADMIN override
//    GET  /finance/moyens-payement              → mes moyens (sans token)
//    POST /finance/moyens-payement              → ajouter un moyen
//    PUT  /finance/moyens-payement/:id          → modifier (default/active)
//    DEL  /finance/moyens-payement/:id          → soft-delete
//    POST /finance/payout-batches               → COOPERATIVE/ADMIN batch
//    GET  /finance/payout-batches               → liste mes batches
//
//  Notes importantes :
//    • Il n'y a PAS de POST /finance/payin. Le payin est initié
//      UNIQUEMENT en interne par OrdersService lors de la création
//      d'une commande. Cela évite qu'un client court-circuite la
//      validation des sources/quantités/prix faite par Orders.
// =====================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import {
  AdminPermission,
  AdminPermissionGuard,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from '@farmcash/auth';
import { FinanceService } from './finance.service';
import {
  ConfirmDeliveryDto,
  CreateMoyenPayementDto,
  CreatePayoutBatchDto,
  ListerTransactionsQueryDto,
  PayoutDto,
  ReleaseEscrowDto,
  TopupWalletDto,
  TopupWalletResponseDto,
  UpdateMoyenPayementDto,
} from './dto/finance.dto';

@ApiTags('💰 Finance & Paiements')
@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@ApiBearerAuth()
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  // ----------------- WALLET -----------------

  @Get('wallet')
  @ApiOperation({ summary: 'Mon solde + transactions paginées' })
  getMyWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListerTransactionsQueryDto,
  ) {
    return this.financeService.getWalletDetails(user.sub, query);
  }

  // ----------------- ESCROW -----------------

  @Post('confirm-delivery')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "BUYER : confirme la livraison → libère l'escrow vers le vendeur",
  })
  confirmDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmDeliveryDto,
  ) {
    return this.financeService.confirmDelivery(user.sub, dto);
  }

  @Post('release-escrow')
  @Roles('ADMIN')
  @AdminPermission('peut_gerer_finance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'ADMIN : libère manuellement un escrow (résolution litige, etc.)',
  })
  releaseEscrowAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReleaseEscrowDto,
  ) {
    return this.financeService.releaseEscrowAdmin(user.sub, dto);
  }

  @Get('reconciliation')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'ADMIN : vérifie la cohérence wallets ↔ transactions (audit)',
  })
  reconciliation() {
    return this.financeService.reconcile();
  }

  // ----------------- PAYOUT -----------------

  @Post('payout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retirer des fonds vers Mobile Money' })
  initiatePayout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayoutDto,
  ) {
    return this.financeService.processPayout(user.sub, dto);
  }

  // ----------------- TOPUP (Chantier 4) -----------------

  @Post('wallet/topup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Recharger son wallet via Mobile Money (OM / MTN / Moov / Wave) — idempotent',
    description:
      "Crée une transaction TOPUP en PENDING et appelle le provider Mobile Money. " +
      "Si le provider répond ACCEPTED synchroniquement, le wallet est crédité immédiatement (status=SUCCESS). " +
      "Sinon, le wallet sera crédité plus tard via le webhook provider (status=PENDING). " +
      "Tous les rôles ayant un wallet sont autorisés. Idempotent via `idempotency_key` (UUID v4 client).",
  })
  @ApiResponse({
    status: 200,
    description: 'Recharge initiée ou créditée (selon le provider).',
    type: TopupWalletResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Moyen de paiement invalide / amount hors bornes.' })
  @ApiResponse({ status: 403, description: 'Wallet gelé.' })
  @ApiResponse({ status: 409, description: "Clé d'idempotence détournée par un autre user." })
  @ApiResponse({ status: 422, description: 'Provider Mobile Money a refusé immédiatement.' })
  topupWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TopupWalletDto,
  ) {
    return this.financeService.topupWallet(user.sub, dto);
  }

  @Get('wallet/topup/:transactionId')
  @ApiOperation({
    summary: 'Statut d\'une recharge wallet (PENDING / SUCCESS / FAILED)',
  })
  @ApiResponse({ status: 200, description: 'Statut courant de la TX TOPUP.' })
  @ApiResponse({ status: 403, description: 'Transaction ne vous appartient pas.' })
  @ApiResponse({ status: 404, description: 'Transaction TOPUP introuvable.' })
  getTopupStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ) {
    return this.financeService.getTopupStatus(user.sub, transactionId);
  }

  // ----------------- MOYENS DE PAIEMENT -----------------

  @Get('moyens-payement')
  @ApiOperation({ summary: 'Mes moyens de paiement (token masqué)' })
  getMoyensPayement(@CurrentUser() user: AuthenticatedUser) {
    return this.financeService.getMoyensPayement(user.sub);
  }

  @Post('moyens-payement')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ajouter un moyen de paiement' })
  addMoyenPayement(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMoyenPayementDto,
  ) {
    return this.financeService.addMoyenPayement(user.sub, dto);
  }

  @Put('moyens-payement/:id')
  @ApiOperation({ summary: 'Modifier un moyen (is_default / is_active)' })
  updateMoyenPayement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMoyenPayementDto,
  ) {
    return this.financeService.updateMoyenPayement(user.sub, id, dto);
  }

  @Delete('moyens-payement/:id')
  @ApiOperation({ summary: 'Supprimer un moyen de paiement (soft)' })
  deleteMoyenPayement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.financeService.deleteMoyenPayement(user.sub, id);
  }

  // ----------------- PAYOUT BATCHES (COOP/ADMIN) -----------------

  @Post('payout-batches')
  @Roles('COOPERATIVE', 'ADMIN')
  // Pour les ADMINs, on impose peut_gerer_finance. Le guard laisse passer
  // automatiquement les utilisateurs role=COOPERATIVE (cf. règle 2 du guard).
  @AdminPermission('peut_gerer_finance')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Crée un batch de paiements (débite le wallet initiateur, crédite chaque bénéficiaire)',
  })
  createPayoutBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePayoutBatchDto,
  ) {
    return this.financeService.createPayoutBatch(user.sub, dto);
  }

  @Get('payout-batches')
  @Roles('COOPERATIVE', 'ADMIN')
  @ApiOperation({ summary: 'Mes batches de paiements (avec items)' })
  listerPayoutBatches(@CurrentUser() user: AuthenticatedUser) {
    return this.financeService.listerPayoutBatches(user.sub);
  }
}
