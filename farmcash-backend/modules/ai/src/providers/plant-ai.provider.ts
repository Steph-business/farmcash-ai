// =====================================================================
//  PROVIDER : PlantAiProvider
//  ---------------------------------------------------------------------
//  Abstraction de l'IA d'analyse de plantes. Tout comme SmsProvider
//  pour les SMS, ce provider isole le métier des détails du fournisseur.
//
//  En dev : génère un diagnostic simulé déterministe (basé sur un hash
//  de l'URL image pour reproductibilité). On peut donc tester tout le
//  flow sans avoir besoin d'IA.
//
//  En prod : à brancher sur l'un des services suivants :
//   • Plant.id API (https://plant.id) — payant, fiable
//   • TensorFlow Lite local (modèle PlantVillage) — gratuit, hors-ligne
//   • Google Cloud Vision avec classifieur custom
//   • Azure Custom Vision
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

export interface PlantDiagnosis {
  disease_detected: string | null;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  confidence_score: number; // 0..1
  recommendations: {
    summary: string;
    treatments: string[]; // codes ou noms suggérés (à matcher avec produits_traitement)
    urgency_hours?: number;
  };
  model_version: string;
}

@Injectable()
export class PlantAiProvider {
  private readonly logger = new Logger(PlantAiProvider.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Analyse une image et renvoie un diagnostic. En dev, retourne un
   * mock déterministe basé sur le hash de l'URL (utile pour les tests :
   * une même URL donne toujours le même résultat).
   */
  async analyze(imageUrl: string): Promise<PlantDiagnosis> {
    const env = this.config.get<string>('NODE_ENV') ?? 'development';
    if (env === 'production') {
      throw new Error(
        'PlantAiProvider: no production AI backend configured. Wire Plant.id or TensorFlow.',
      );
    }

    // Mock déterministe pour dev/test.
    const hash = createHash('sha256').update(imageUrl).digest();
    const bucket = hash[0] % 4;
    const samples: PlantDiagnosis[] = [
      {
        disease_detected: null,
        risk_level: 'LOW',
        confidence_score: 0.92,
        recommendations: {
          summary: 'Plante en bonne santé. Continuez le suivi habituel.',
          treatments: [],
        },
        model_version: 'mock-v1',
      },
      {
        disease_detected: 'mildiou',
        risk_level: 'MEDIUM',
        confidence_score: 0.78,
        recommendations: {
          summary:
            'Détection probable de mildiou. Traitement préventif recommandé sous 48h.',
          treatments: ['Cuivrosan 50 WG', 'Aliette WG'],
          urgency_hours: 48,
        },
        model_version: 'mock-v1',
      },
      {
        disease_detected: 'pourriture noire',
        risk_level: 'HIGH',
        confidence_score: 0.84,
        recommendations: {
          summary:
            'Pourriture noire détectée. Isolez les plants atteints et traitez immédiatement.',
          treatments: ['Mancozèbe 80 WP'],
          urgency_hours: 24,
        },
        model_version: 'mock-v1',
      },
      {
        disease_detected: 'cochenille',
        risk_level: 'CRITICAL',
        confidence_score: 0.71,
        recommendations: {
          summary:
            'Infestation critique de cochenilles. Intervention immédiate requise pour éviter la propagation.',
          treatments: ['Confidor 200 SL', 'Karaté Zeon 5 EC'],
          urgency_hours: 12,
        },
        model_version: 'mock-v1',
      },
    ];

    const result = samples[bucket];
    this.logger.debug(
      `[DEV] Mock diagnosis for ${imageUrl}: ${result.disease_detected ?? 'healthy'} (${result.risk_level})`,
    );
    return result;
  }
}
