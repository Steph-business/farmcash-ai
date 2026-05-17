// =====================================================================
//  SERVICE : AiAssistantService
//  ---------------------------------------------------------------------
//  Assistant IA conversationnel. Cas d'usage principal pour les FARMER
//  peu alphabétisés ou peu à l'aise avec l'app : on tape (ou on dicte
//  côté client puis on envoie le texte transcrit) et l'IA :
//    • Comprend l'intention (publier annonce, demander prix, conseils…)
//    • Répond dans la langue du user (français/dioula/…)
//    • Si tool-use : exécute l'action concrète (ex. publier l'annonce
//      via MarketplaceService)
//    • Persiste l'échange dans `conversations` (is_ai_session=true) +
//      `messages` (role='user' ou 'assistant') pour conserver le contexte.
// =====================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { MarketplaceService } from '@farmcash/marketplace';
import {
  ChatMessageDto,
  ListAiHistoryQueryDto,
} from './dto/assistant.dto';
import { LlmMessage, LlmProvider, LlmResponse } from './providers/llm.provider';

// Limite la taille de l'historique envoyé au LLM (tokens / coût).
const HISTORY_WINDOW = 20;

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmProvider,
    private readonly marketplace: MarketplaceService,
  ) {}

  /**
   * Reçoit un message du user, appelle le LLM, exécute éventuellement un
   * tool_call, persiste les 2 messages (user + assistant), retourne la
   * réponse + un éventuel résultat d'action.
   */
  async chat(userId: string, dto: ChatMessageDto) {
    // 1. Récupère/crée la conversation IA.
    const conversation = await this.getOrCreateAiConversation(
      userId,
      dto.conversation_id,
    );

    // 2. Récupère le user pour le contexte LLM (langue, role).
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, role: true, langue: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    // 3. Persiste le message user.
    await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        sender_id: userId,
        role: 'user',
        content: dto.message,
        status: 'SENT',
      },
    });

    // 4. Construit l'historique LLM (limité aux N derniers messages).
    const history = await this.buildLlmHistory(conversation.id);

    // 5. Appelle le LLM.
    let llmResponse: LlmResponse;
    try {
      llmResponse = await this.llm.generate(history, dto.message, {
        role: user.role,
        langue: user.langue,
        user_id: userId,
      });
    } catch (err) {
      this.logger.error(`LLM failed: ${(err as Error).message}`);
      llmResponse = {
        content: 'Désolé, je rencontre un problème technique. Réessayez plus tard.',
        metadata: { error: true },
      };
    }

    // 6. Exécute éventuel tool_call.
    let toolResult: unknown = null;
    if (llmResponse.tool_call) {
      try {
        toolResult = await this.executeToolCall(userId, user.role, llmResponse.tool_call);
        this.logger.log(
          `Tool executed: ${llmResponse.tool_call.name} for user=${userId}`,
        );
      } catch (err) {
        this.logger.warn(`Tool failed: ${(err as Error).message}`);
        llmResponse = {
          ...llmResponse,
          content: `${llmResponse.content}\n\n⚠️ Je n'ai pas pu exécuter l'action : ${(err as Error).message}`,
        };
      }
    }

    // 7. Persiste la réponse assistant.
    const assistantMessage = await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        sender_id: null,
        role: 'assistant',
        content: llmResponse.content,
        status: 'SENT',
        metadata: {
          ...(llmResponse.metadata ?? {}),
          tool_call: llmResponse.tool_call ?? null,
          tool_result: toolResult,
        } as Prisma.InputJsonValue,
      },
    });

    // 8. Met à jour le timestamp + ai_context.
    await this.prisma.conversations.update({
      where: { id: conversation.id },
      data: {
        last_message_at: new Date(),
        ai_context: {
          last_intent: (llmResponse.metadata as any)?.intent ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      conversation_id: conversation.id,
      reply: assistantMessage,
      tool_result: toolResult,
    };
  }

  /**
   * Liste paginée des messages de la conversation IA du user (du plus
   * récent au plus ancien).
   */
  async getHistory(userId: string, query: ListAiHistoryQueryDto) {
    const conv = await this.findActiveAiConversation(userId);
    if (!conv) return { conversation_id: null, data: [], meta: this.emptyMeta(query) };

    const page = query.page ?? 1;
    const limit = query.limit ?? 30;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.messages.findMany({
        where: { conversation_id: conv.id },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.messages.count({ where: { conversation_id: conv.id } }),
    ]);

    return {
      conversation_id: conv.id,
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Réinitialise la session IA en créant une nouvelle conversation.
   * L'ancienne reste accessible en lecture mais n'est plus active.
   */
  async resetSession(userId: string) {
    const conv = await this.prisma.conversations.create({
      data: {
        is_ai_session: true,
        type: 'DIRECT',
        titre: 'Session IA',
        conversation_participants: { create: { user_id: userId } },
        ai_context: {} as Prisma.InputJsonValue,
      },
    });
    return { message: 'Nouvelle session IA démarrée.', conversation_id: conv.id };
  }

  // -------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------

  /**
   * Soit reprend la session IA active du user, soit en crée une nouvelle.
   * Une seule session IA active par user à la fois (la plus récente).
   */
  private async getOrCreateAiConversation(
    userId: string,
    explicitId?: string,
  ) {
    if (explicitId) {
      const c = await this.prisma.conversations.findUnique({
        where: { id: explicitId },
        include: { conversation_participants: true },
      });
      if (
        c &&
        c.is_ai_session &&
        c.conversation_participants.some((p) => p.user_id === userId)
      ) {
        return c;
      }
    }
    const active = await this.findActiveAiConversation(userId);
    if (active) return active;
    return this.prisma.conversations.create({
      data: {
        is_ai_session: true,
        type: 'DIRECT',
        titre: 'Session IA',
        conversation_participants: { create: { user_id: userId } },
        ai_context: {} as Prisma.InputJsonValue,
      },
      include: { conversation_participants: true },
    });
  }

  private async findActiveAiConversation(userId: string) {
    return this.prisma.conversations.findFirst({
      where: {
        is_ai_session: true,
        conversation_participants: { some: { user_id: userId } },
      },
      orderBy: { last_message_at: 'desc' },
      include: { conversation_participants: true },
    });
  }

  /**
   * Construit l'historique LLM depuis les N derniers messages persistés.
   * On inverse l'ordre pour avoir le plus ancien en premier (format LLM).
   */
  private async buildLlmHistory(conversationId: string): Promise<LlmMessage[]> {
    const recent = await this.prisma.messages.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'desc' },
      take: HISTORY_WINDOW,
    });
    return recent
      .reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
  }

  /**
   * Exécute un tool_call demandé par le LLM. Le service garde le
   * contrôle des permissions : seul un FARMER peut publier une annonce
   * via tool_call, etc.
   */
  private async executeToolCall(
    userId: string,
    role: string,
    toolCall: { name: string; args: Record<string, unknown> },
  ): Promise<unknown> {
    switch (toolCall.name) {
      case 'create_annonce_vente': {
        if (role !== 'FARMER') {
          throw new Error('Seul un FARMER peut publier une annonce de vente.');
        }
        // On extrait ce qui est utilisable. Les champs manquants côté LLM
        // (produit_id, region_id, ville_id, coords) doivent être complétés
        // côté front avant publication. Pour le MVP stub, on retourne juste
        // un "draft" que le client peut compléter et envoyer à /marketplace.
        return {
          status: 'draft',
          suggested: toolCall.args,
          next_step:
            "Complétez produit_id, region_id, ville_id et coordonnées, puis appelez POST /marketplace/annonces/vente.",
        };
      }
      default:
        throw new Error(`Tool inconnu : ${toolCall.name}`);
    }
  }

  private emptyMeta(query: ListAiHistoryQueryDto) {
    return {
      total: 0,
      page: query.page ?? 1,
      limit: query.limit ?? 30,
      last_page: 1,
    };
  }
}
