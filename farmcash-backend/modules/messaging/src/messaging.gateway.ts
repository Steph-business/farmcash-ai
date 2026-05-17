// =====================================================================
//  GATEWAY WebSocket : MessagingGateway
//  ---------------------------------------------------------------------
//  Permet aux clients connectés (app mobile, web) de recevoir les
//  nouveaux messages en temps réel sans polling.
//
//  ⚠️ SÉCURITÉ — Authentification au handshake :
//   Le client DOIT fournir un Bearer JWT dans :
//     • auth.token (préférable, recommandé par socket.io)
//     • OU header Authorization: Bearer <jwt>
//   Si absent ou invalide → la connexion est REFUSÉE immédiatement.
//
//   Le userId n'est plus jamais lu depuis le client : il est extrait
//   du JWT vérifié → impossible d'usurper l'identité.
//
//  Évènements client → serveur :
//    "joinConversation" : { conversationId }
//        Refuse si le user n'est pas participant de la conversation.
//    "sendMessage"      : { conversationId, content, media_type?, media_url? }
//        Le sender est forcé à userId du JWT (ignore tout user_id du body).
//
//  Évènements serveur → clients :
//    "newMessage"       : { id, content, sender_id, ... }
//        Diffusé à la "room" de la conversation après persistance.
// =====================================================================

import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/messaging.dto';

interface AuthenticatedSocket extends Socket {
  data: {
    userId?: string;
  };
}

@WebSocketGateway({
  cors: { origin: process.env.WS_CORS_ORIGIN ?? '*' },
  namespace: 'messaging',
})
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('MessagingGateway');

  constructor(
    private readonly messagingService: MessagingService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Vérifie le JWT au handshake. Si invalide → disconnect.
   */
  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(`Connection refused (no token): ${client.id}`);
      client.emit('error', { message: 'JWT requis' });
      client.disconnect(true);
      return;
    }
    try {
      const payload = await this.jwtService.verifyAsync(token);
      client.data.userId = payload.sub;
      this.messagingService.setOnlineStatus(payload.sub, true);
      this.logger.log(`Client connected: user=${payload.sub} socket=${client.id}`);
    } catch {
      this.logger.warn(`Connection refused (invalid token): ${client.id}`);
      client.emit('error', { message: 'JWT invalide' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    const userId = client.data.userId;
    if (userId) {
      // Note: en horizontal scaling, le online-status devrait être
      // dans Redis. Ici on suppose un seul process.
      this.messagingService.setOnlineStatus(userId, false);
      this.logger.log(`Client disconnected: user=${userId}`);
    }
  }

  /**
   * Le client demande à rejoindre la room d'une conversation. On vérifie
   * qu'il en est bien participant avant de l'ajouter.
   */
  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId;
    if (!userId) {
      return { status: 'error', message: 'Non authentifié' };
    }
    const isParticipant = await this.messagingService.isUserInConversation(
      userId,
      data.conversationId,
    );
    if (!isParticipant) {
      return { status: 'error', message: 'Accès refusé à cette conversation' };
    }
    client.join(data.conversationId);
    this.logger.log(
      `User ${userId} joined conversation ${data.conversationId}`,
    );
    return { status: 'joined', conversationId: data.conversationId };
  }

  /**
   * Envoi d'un message via WebSocket. Le sender_id est FORCÉ à userId
   * du JWT — le body ne peut pas le surcharger.
   */
  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    data: {
      conversationId: string;
      content: string;
      media_type?: any;
      media_url?: string;
    },
  ) {
    const userId = client.data.userId;
    if (!userId) {
      return { status: 'error', message: 'Non authentifié' };
    }
    const dto: SendMessageDto = {
      content: data.content,
      media_type: data.media_type,
      media_url: data.media_url,
    };
    try {
      const message = await this.messagingService.sendMessage(
        userId,
        data.conversationId,
        dto,
      );
      // Diffuse uniquement aux participants ayant rejoint la room.
      this.server.to(data.conversationId).emit('newMessage', message);
      return message;
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
  }

  // -------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------

  /**
   * Extrait le JWT depuis l'auth handshake (socket.io recommandé) OU
   * le header Authorization en fallback.
   */
  private extractToken(client: Socket): string | undefined {
    const fromAuth = (client.handshake.auth as { token?: string } | undefined)
      ?.token;
    if (fromAuth) return fromAuth;
    const header = client.handshake.headers['authorization'];
    if (!header) return undefined;
    const [type, token] = String(header).split(' ');
    return type?.toLowerCase() === 'bearer' ? token : undefined;
  }
}
