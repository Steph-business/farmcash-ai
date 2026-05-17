// =====================================================================
//  SERVICE : PlantAnalysesService
//  ---------------------------------------------------------------------
//  Diagnostic IA des plantes. Le FARMER envoie une photo (URL), on
//  appelle PlantAiProvider, on persiste le résultat + on retourne le
//  diagnostic au client.
//
//  Si une parcelle est précisée, on vérifie l'ownership (le user ne
//  peut analyser que des photos sur SES parcelles, pas celles d'autrui).
// =====================================================================

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import {
  AnalyzePlantDto,
  ListPlantAnalysesQueryDto,
} from './dto/plant-analyses.dto';
import { PlantAiProvider } from './providers/plant-ai.provider';

@Injectable()
export class PlantAnalysesService {
  private readonly logger = new Logger(PlantAnalysesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plantAi: PlantAiProvider,
  ) {}

  /**
   * Lance une analyse IA sur une photo et persiste le résultat.
   *
   * Étapes :
   *   1. Si parcelle_id fourni, vérifie ownership.
   *   2. Appel à PlantAiProvider (mock en dev, vrai backend en prod).
   *   3. Insertion en DB (avec GPS si fourni, via $queryRaw pour PostGIS).
   *   4. Retourne l'analyse créée.
   */
  async analyze(farmerId: string, dto: AnalyzePlantDto) {
    if (dto.parcelle_id) {
      const parcelle = await this.prisma.parcelle.findFirst({
        where: { id: dto.parcelle_id, user_id: farmerId },
        select: { id: true },
      });
      if (!parcelle) {
        throw new ForbiddenException("Parcelle non rattachée à votre compte.");
      }
    }

    const diagnosis = await this.plantAi.analyze(dto.image_url);

    // Insertion via $queryRaw pour pouvoir mettre la geography PostGIS.
    let analysis;
    if (dto.location) {
      const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO plant_analyses (
          farmer_id, parcelle_id, produit_id, image_url,
          disease_detected, risk_level, confidence_score,
          recommendations, location, model_version
        ) VALUES (
          ${farmerId}::uuid,
          ${dto.parcelle_id ?? null}::uuid,
          ${dto.produit_id ?? null}::uuid,
          ${dto.image_url},
          ${diagnosis.disease_detected},
          ${diagnosis.risk_level},
          ${diagnosis.confidence_score},
          ${JSON.stringify(diagnosis.recommendations)}::jsonb,
          ST_SetSRID(ST_MakePoint(${dto.location.lng}, ${dto.location.lat}), 4326),
          ${diagnosis.model_version}
        ) RETURNING id;
      `;
      analysis = await this.prisma.plant_analyses.findUnique({
        where: { id: inserted[0].id },
      });
    } else {
      analysis = await this.prisma.plant_analyses.create({
        data: {
          farmer_id: farmerId,
          parcelle_id: dto.parcelle_id,
          produit_id: dto.produit_id,
          image_url: dto.image_url,
          disease_detected: diagnosis.disease_detected,
          risk_level: diagnosis.risk_level,
          confidence_score: diagnosis.confidence_score,
          recommendations: diagnosis.recommendations as Prisma.InputJsonValue,
          model_version: diagnosis.model_version,
        },
      });
    }

    this.logger.log(
      `Plant analysis: farmer=${farmerId} disease=${diagnosis.disease_detected ?? 'healthy'} risk=${diagnosis.risk_level}`,
    );
    return { analysis, diagnosis };
  }

  /**
   * Historique paginé des analyses du farmer. Filtre optionnel par
   * niveau de risque (utile pour "mes alertes critiques").
   */
  async getMyAnalyses(farmerId: string, query: ListPlantAnalysesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.plant_analysesWhereInput = {
      farmer_id: farmerId,
      ...(query.risk_level && { risk_level: query.risk_level }),
    };

    const [data, total] = await Promise.all([
      this.prisma.plant_analyses.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          parcelle: { select: { id: true, nom: true } },
          produits_agricoles: { select: { id: true, nom: true } },
        },
      }),
      this.prisma.plant_analyses.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Détail d'une analyse. Ownership stricte : le farmer ne voit que
   * les siennes (les ADMINs verraient tout via le module oversight).
   */
  async getById(farmerId: string, id: string) {
    const analysis = await this.prisma.plant_analyses.findUnique({
      where: { id },
      include: {
        parcelle: true,
        produits_agricoles: true,
      },
    });
    if (!analysis) throw new NotFoundException('Analyse introuvable.');
    if (analysis.farmer_id !== farmerId) {
      throw new ForbiddenException('Cette analyse ne vous appartient pas.');
    }
    return analysis;
  }
}
