// =====================================================================
//  CONTROLLER : MessagingController
//  ---------------------------------------------------------------------
//  API REST pour les conversations et messages. Le WebSocket Gateway
//  est documenté séparément dans messaging.gateway.ts (canal temps réel).
// =====================================================================

import {
  Body,
  Controller,
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, PaginationDto } from '@farmcash/shared';
import { JwtAuthGuard } from '@farmcash/auth';
import { MessagingService } from './messaging.service';
import {
  CreateConversationDto,
  ListMessagesQueryDto,
  SendMessageDto,
} from './dto/messaging.dto';

@ApiTags('💬 Messaging')
@Controller('messaging')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post('conversations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trouver ou créer une conversation' })
  findOrCreateConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConversationDto,
  ) {
    return this.messagingService.findOrCreateConversation(user.sub, dto);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Lister mes conversations (paginées)' })
  getUserConversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.messagingService.getUserConversations(
      user.sub,
      pagination.page ?? 1,
      pagination.limit ?? 20,
    );
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Envoyer un message texte ou média' })
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(user.sub, id, dto);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: "Messages d'une conversation (paginés, plus récent en premier)" })
  getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messagingService.getConversationMessages(user.sub, id, query);
  }

  @Put('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marquer la conversation comme lue' })
  markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.messagingService.markAsRead(user.sub, id);
  }
}
