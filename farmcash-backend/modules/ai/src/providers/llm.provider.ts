// =====================================================================
//  PROVIDER : LlmProvider
//  ---------------------------------------------------------------------
//  Abstraction du LLM (modèle de langage type Claude, GPT, Gemini).
//
//  En dev : stub déterministe avec extraction d'intent par mots-clés.
//   - Détecte les intents : PUBLISH_SALE, PRICE_QUERY, GREETING, HELP
//   - Retourne une réponse cohérente + un tool_call optionnel
//
//  En prod : à brancher sur :
//   • Anthropic Messages API (Claude) — recommandé pour multilingue
//   • OpenAI Chat Completions (GPT-4o)
//   • Google Gemini API
//
//  Le contrat de sortie inclut un éventuel `tool_call` (function call)
//  que l'AssistantService peut exécuter (ex: publier une annonce).
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmToolCall {
  /** Nom de l'action à exécuter par l'AssistantService. */
  name: string;
  /** Arguments structurés extraits du message user. */
  args: Record<string, unknown>;
}

export interface LlmResponse {
  /** Réponse textuelle à afficher au user. */
  content: string;
  /** Optionnel : action à exécuter par le service appelant. */
  tool_call?: LlmToolCall;
  /** Métadonnées additionnelles (langue détectée, confidence, etc.). */
  metadata?: Record<string, unknown>;
}

@Injectable()
export class LlmProvider {
  private readonly logger = new Logger(LlmProvider.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Envoie une conversation au LLM et retourne sa réponse.
   *
   * @param history Messages précédents (system + user + assistant alternés).
   * @param userMessage Dernier message de l'utilisateur (sera traité).
   * @param context Contexte structuré du user (role, langue préférée, etc.)
   */
  async generate(
    history: LlmMessage[],
    userMessage: string,
    context: { role: string; langue: string; user_id: string },
  ): Promise<LlmResponse> {
    const env = this.config.get<string>('NODE_ENV') ?? 'development';
    if (env === 'production') {
      throw new Error(
        'LlmProvider: no production LLM backend configured. Wire Claude/GPT/Gemini.',
      );
    }

    // ---- Mode mock déterministe ----
    const text = userMessage.toLowerCase().trim();

    // Intent : publier une annonce de vente
    if (this.matchesAny(text, ['vendre', 'vente', 'publier', 'mettre en vente'])) {
      const extracted = this.extractSaleIntent(userMessage);
      if (extracted.quantite_kg && extracted.prix_par_kg && extracted.produit_hint) {
        return {
          content: `J'ai compris : vous voulez vendre **${extracted.quantite_kg} kg** de ${extracted.produit_hint} à **${extracted.prix_par_kg} FCFA/kg**. Je publie l'annonce.`,
          tool_call: {
            name: 'create_annonce_vente',
            args: extracted,
          },
          metadata: { intent: 'PUBLISH_SALE', mock: true },
        };
      }
      return {
        content:
          "D'accord, vous voulez publier une annonce. Pouvez-vous préciser : quel produit, combien de kilos, et quel prix par kilo ?",
        metadata: { intent: 'PUBLISH_SALE_INCOMPLETE', mock: true },
      };
    }

    // Intent : demande de prix / tendances
    if (this.matchesAny(text, ['prix', 'tarif', 'combien', 'tendance'])) {
      return {
        content:
          "Cette semaine en Côte d'Ivoire : maïs blanc ~350 FCFA/kg, igname Kponan ~600 FCFA/kg, manioc frais ~200 FCFA/kg, ananas ~450 FCFA/kg.",
        metadata: { intent: 'PRICE_QUERY', mock: true },
      };
    }

    // Intent : salutation
    if (this.matchesAny(text, ['bonjour', 'salam', 'hello'])) {
      const greet =
        context.langue === 'en'
          ? 'Hello! How can I help you?'
          : 'Bonjour ! Comment puis-je vous aider ?';
      return {
        content: greet,
        metadata: { intent: 'GREETING', mock: true },
      };
    }

    // Intent : aide
    if (this.matchesAny(text, ['aide', 'aider', 'comment', 'help'])) {
      return {
        content:
          "Je peux vous aider à :\n• Publier une annonce de vente (\"je veux vendre X kg de Y à Z FCFA\")\n• Connaître les prix actuels (\"prix du maïs\", \"prix de l'igname\")\n• Comprendre votre tableau de bord\n• Trouver un transporteur",
        metadata: { intent: 'HELP', mock: true },
      };
    }

    // Réponse par défaut.
    return {
      content:
        "Je n'ai pas tout compris. Reformulez ou tapez 'aide' pour voir ce que je peux faire.",
      metadata: { intent: 'FALLBACK', mock: true },
    };
  }

  // -------------------------------------------------------------------
  //  Helpers stub
  // -------------------------------------------------------------------

  private matchesAny(text: string, keywords: string[]): boolean {
    return keywords.some((k) => text.includes(k));
  }

  /**
   * Extraction grossière d'une intention de vente depuis du texte libre.
   * En prod, on utilisera le tool-use natif du LLM (structured output).
   */
  private extractSaleIntent(text: string): {
    quantite_kg?: number;
    prix_par_kg?: number;
    produit_hint?: string;
  } {
    const result: { quantite_kg?: number; prix_par_kg?: number; produit_hint?: string } = {};

    // Quantité (200 kg, 500kg, 2000 kilos…)
    const qty = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?)/i);
    if (qty) result.quantite_kg = parseFloat(qty[1]);

    // Prix au kg (1500 FCFA, 1.500 F, 1200 par kg…)
    const price = text.match(/(\d+(?:\.\d+)?)\s*(?:f|fcfa|francs?)?\s*(?:\/|par|le)\s*kg/i);
    if (price) result.prix_par_kg = parseFloat(price[1].replace('.', ''));

    // Produit (mots-clés courants CI — produits vivriers uniquement
    // pour la v1 ; les produits de rente — cacao, café, anacarde — sont
    // hors périmètre tant qu'on n'a pas le cadre réglementaire export).
    const products = [
      'ananas', 'manioc', 'igname', 'banane',
      'mangue', 'tomate', 'piment', 'gombo', 'riz', 'maïs', 'mais',
      'oignon', 'aubergine', 'arachide', 'haricot', 'avocat', 'patate',
    ];
    for (const p of products) {
      if (text.toLowerCase().includes(p)) {
        result.produit_hint = p;
        break;
      }
    }

    return result;
  }
}
