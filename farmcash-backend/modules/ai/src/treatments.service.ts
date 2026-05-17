// =====================================================================
//  SERVICE : TreatmentsService
//  ---------------------------------------------------------------------
//  Catalogue de produits de traitement agricole. Géré par ADMIN
//  (CRUD complet), consulté par FARMER (recherche par maladie/culture
//  ou via une analyse IA précédente).
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
  CreateTreatmentDto,
  ListTreatmentsQueryDto,
  UpdateTreatmentDto,
} from './dto/treatments.dto';

@Injectable()
export class TreatmentsService {
  private readonly logger = new Logger(TreatmentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liste paginée du catalogue avec filtres optionnels par maladie,
   * culture, et type.
   */
  async list(query: ListTreatmentsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.produits_traitementWhereInput = {
      ...(query.type && { type: query.type }),
      // Pour les array fields PostgreSQL, on utilise `has` (contient cette valeur).
      ...(query.disease && { maladies_cibles: { has: query.disease } }),
      ...(query.culture && { cultures_cibles: { has: query.culture } }),
    };

    const [data, total] = await Promise.all([
      this.prisma.produits_traitement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { nom: 'asc' },
      }),
      this.prisma.produits_traitement.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  async getById(id: string) {
    const t = await this.prisma.produits_traitement.findUnique({
      where: { id },
    });
    if (!t) throw new NotFoundException('Traitement introuvable.');
    return t;
  }

  /**
   * Recherche autocomplete par préfixe / contains sur le nom.
   * Utilisé par les frontends mobile pour le champ "traitements appliqués"
   * lors de la création d'une annonce. Retourne max 20 résultats.
   */
  async search(q: string) {
    if (!q || q.trim().length < 2) return [];
    return this.prisma.produits_traitement.findMany({
      where: { nom: { contains: q.trim(), mode: 'insensitive' } },
      orderBy: { nom: 'asc' },
      take: 20,
      select: {
        id: true,
        nom: true,
        type: true,
        cultures_cibles: true,
        delai_carence_j: true,
      },
    });
  }

  /**
   * Recommande des traitements basés sur le diagnostic d'une analyse
   * IA. Croise le `disease_detected` de l'analyse avec
   * `maladies_cibles` du catalogue.
   */
  async getForAnalysis(callerId: string, analysisId: string) {
    const analysis = await this.prisma.plant_analyses.findUnique({
      where: { id: analysisId },
      select: { disease_detected: true, farmer_id: true },
    });
    if (!analysis) throw new NotFoundException('Analyse introuvable.');
    // Anti-leak : seul le farmer propriétaire de l'analyse peut voir les
    // traitements suggérés (sinon on permettrait d'inférer les maladies
    // d'autres producteurs).
    if (analysis.farmer_id !== callerId) {
      throw new ForbiddenException('Analyse non rattachée à votre compte.');
    }
    if (!analysis.disease_detected) return [];

    return this.prisma.produits_traitement.findMany({
      where: { maladies_cibles: { has: analysis.disease_detected } },
      orderBy: { nom: 'asc' },
    });
  }

  // ADMIN

  async create(dto: CreateTreatmentDto) {
    return this.prisma.produits_traitement.create({
      data: {
        nom: dto.nom,
        type: dto.type,
        cultures_cibles: dto.cultures_cibles ?? [],
        maladies_cibles: dto.maladies_cibles ?? [],
        dosage: dto.dosage,
        mode_application: dto.mode_application,
        delai_carence_j: dto.delai_carence_j,
      },
    });
  }

  async update(id: string, dto: UpdateTreatmentDto) {
    await this.getById(id);
    return this.prisma.produits_traitement.update({
      where: { id },
      data: {
        ...(dto.nom !== undefined && { nom: dto.nom }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.cultures_cibles !== undefined && {
          cultures_cibles: dto.cultures_cibles,
        }),
        ...(dto.maladies_cibles !== undefined && {
          maladies_cibles: dto.maladies_cibles,
        }),
        ...(dto.dosage !== undefined && { dosage: dto.dosage }),
        ...(dto.mode_application !== undefined && {
          mode_application: dto.mode_application,
        }),
        ...(dto.delai_carence_j !== undefined && {
          delai_carence_j: dto.delai_carence_j,
        }),
      },
    });
  }

  async delete(id: string) {
    await this.getById(id);
    await this.prisma.produits_traitement.delete({ where: { id } });
    return { message: 'Traitement supprimé.' };
  }
}
