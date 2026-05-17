// =====================================================================
//  CONTROLLER : ExporterOversightController
//  ---------------------------------------------------------------------
//  Routes EXPORTER — vue des commandes B2B + documents + offres.
// =====================================================================

import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { ExporterOversightService } from './exporter-oversight.service';
import { PaginationQueryDto } from './dto/oversight.dto';

@ApiTags('👁️ Oversight Exporter B2B')
@Controller('oversight/exporter')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('EXPORTER')
@ApiBearerAuth()
export class ExporterOversightController {
  constructor(private readonly service: ExporterOversightService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Tableau de bord exporter (KPIs B2B)' })
  getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOverview(user.sub);
  }

  @Get('commandes-b2b')
  @ApiOperation({ summary: 'Mes commandes B2B paginées' })
  listB2bOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.listB2bOrders(user.sub, query);
  }

  @Get('commandes-b2b/:id/documents')
  @ApiOperation({ summary: "Documents export d'une commande B2B" })
  listDocs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.listExportDocs(user.sub, id);
  }

  @Get('offres')
  @ApiOperation({ summary: 'Mes offres marché B2B' })
  listMyOffres(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.listMyOffres(user.sub, query);
  }
}
