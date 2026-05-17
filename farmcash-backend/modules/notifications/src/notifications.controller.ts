// =====================================================================
//  CONTROLLER : NotificationsController
//  ---------------------------------------------------------------------
//  Routes consommées par le client mobile/web pour consulter ses notifs.
//
//  PAS DE ROUTE POUR CRÉER UNE NOTIFICATION : c'est uniquement en
//  interne, via DI, depuis les autres services (Orders, Finance, etc.).
//
//  PAS DE ROUTE FCM : l'enregistrement du token FCM passe par
//  POST /auth/device-token (cf. module auth) pour éviter la duplication.
// =====================================================================

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
// Import direct (pas via le barrel) pour éviter un cycle CJS :
// auth → cooperatives → notifications → (auth barrel).
import { JwtAuthGuard } from '@farmcash/auth/guards/jwt.guard';
import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto } from './dto/notifications.dto';

@ApiTags('🔔 Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Mes notifications paginées (type, unread filtres)' })
  getUserNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notificationsService.getUserNotifications(user.sub, query);
  }

  @Sse('stream')
  @ApiOperation({ summary: 'Flux SSE temps réel des notifs de l\'utilisateur' })
  streamNotifications(
    @CurrentUser() user: AuthenticatedUser,
  ): Observable<MessageEvent> {
    return this.notificationsService.getNotificationsStream().pipe(
      filter((event) => event.userId === user.sub),
      map(
        (event) =>
          ({
            data: event.notification,
            type: 'notification',
          }) as MessageEvent,
      ),
    );
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marquer une notif comme lue' })
  markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notificationsService.markAsRead(user.sub, id);
  }

  @Put('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marquer toutes mes notifs comme lues' })
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user.sub);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer une notification' })
  deleteNotification(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notificationsService.delete(user.sub, id);
  }
}
