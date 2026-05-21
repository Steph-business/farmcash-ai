// =====================================================================
//  CONTROLLER : OrdersController
//  ---------------------------------------------------------------------
//  Routes des commandes + des litiges (disputes), regroupées dans un
//  seul controller car le cycle de vie d'un litige est lié à celui
//  d'une commande.
//
//  Toutes les routes exigent un JWT. La granularité fine (qui peut
//  faire quoi sur une commande donnée) est dans le service, via la
//  state machine et la matrice acteur (cf. orders.service.ts).
// =====================================================================

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { OrdersService } from './orders.service';
import {
  CreateOrderDto,
  ListerOrdersQueryDto,
  OpenDisputeDto,
  PayOrderDto,
  ResolveDisputeDto,
  UpdateOrderStatusDto,
} from './dto/orders.dto';

@ApiTags('📦 Commandes (Orders)')
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // ===================================================================
  //  COMMANDES
  // ===================================================================

  @Post()
  @Roles('BUYER', 'COOPERATIVE')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Créer une commande. La source (annonce, candidature, etc.) est vérifiée côté serveur.",
    description:
      "Pour éviter les doubles paiements en cas de retry réseau, envoyer un header `Idempotency-Key` unique. Si la même clé est reçue 2x, la commande existante est renvoyée.",
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.ordersService.createOrder(user.sub, dto, idempotencyKey);
  }

  @Post(':id/pay')
  @Roles('BUYER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Paie une commande déjà créée (typiquement après acceptation d'une candidature/proposition).",
    description:
      "Lance le payin sur une commande SENT existante. Anti-double-paiement : refus si un escrow est déjà LOCKED. Header `Idempotency-Key` accepté pour la retry-safety du transport (le verrouillage applicatif via escrow LOCKED reste la garde-fou principale).",
  })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PayOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.ordersService.payOrder(user.sub, id, dto, idempotencyKey);
  }

  @Get('my')
  @ApiOperation({ summary: 'Lister mes commandes (acheteur + vendeur par défaut)' })
  getMyOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListerOrdersQueryDto,
  ) {
    return this.ordersService.getMyOrders(user.sub, query);
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail d'une commande (403 si tiers)" })
  getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.ordersService.getOrderById(user.sub, id);
  }

  @Put(':id/status')
  @ApiOperation({
    summary:
      "Changer le statut. Soumis à la state machine + matrice acteur (seller/buyer/admin).",
  })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(user.sub, id, dto);
  }

  // ===================================================================
  //  DISPUTES
  // ===================================================================

  @Post('disputes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ouvrir un litige sur une commande' })
  openDispute(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OpenDisputeDto,
  ) {
    return this.ordersService.openDispute(user.sub, dto);
  }

  @Get('disputes/my')
  @ApiOperation({ summary: 'Mes litiges (ou tous pour un ADMIN)' })
  listerDisputes(@CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.listerDisputes(user.sub, user.role === 'ADMIN');
  }

  @Put('disputes/:id/resolve')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Résoudre un litige (ADMIN uniquement)' })
  resolveDispute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.ordersService.resolveDispute(user.sub, id, dto);
  }
}
