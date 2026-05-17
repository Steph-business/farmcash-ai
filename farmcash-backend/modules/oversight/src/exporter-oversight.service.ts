// =====================================================================
//  SERVICE : ExporterOversightService
//  ---------------------------------------------------------------------
//  Vue pour les EXPORTERS B2B : commandes export, documents douaniers,
//  offres de marché B2B émises.
//
//  Périmètre :
//   • commande_b2b où exporter_id = userId
//   • export_documents associés
//   • offres_marche_b2b émises par l'exporter
// =====================================================================

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { PaginationQueryDto } from './dto/oversight.dto';

@Injectable()
export class ExporterOversightService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dashboard EXPORTER : KPIs sur les commandes B2B + documents.
   */
  async getOverview(exporterId: string) {
    const [
      ordersByStatus,
      totalValue,
      pendingDocs,
      activeOffres,
    ] = await Promise.all([
      this.prisma.commande_b2b.groupBy({
        by: ['status'],
        where: { exporter_id: exporterId },
        _count: true,
      }),
      this.prisma.commande_b2b.aggregate({
        where: { exporter_id: exporterId },
        _sum: { montant_usd: true },
      }),
      this.prisma.export_documents.count({
        where: {
          is_validated: false,
          commande_b2b: { exporter_id: exporterId },
        },
      }),
      this.prisma.offres_marche_b2b.count({
        where: { exporter_id: exporterId },
      }),
    ]);

    return {
      commandes_b2b: {
        by_status: ordersByStatus.reduce(
          (acc, r) => ({ ...acc, [r.status ?? 'UNKNOWN']: r._count }),
          {} as Record<string, number>,
        ),
        total_value_usd: totalValue._sum.montant_usd?.toNumber() ?? 0,
      },
      pending_documents: pendingDocs,
      active_offres_b2b: activeOffres,
    };
  }

  /**
   * Liste paginée des commandes B2B de l'exporter.
   */
  async listB2bOrders(exporterId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.commande_b2bWhereInput = { exporter_id: exporterId };

    const [data, total] = await Promise.all([
      this.prisma.commande_b2b.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          produits_agricoles: { select: { nom: true } },
          users_commande_b2b_supplier_idTousers: {
            select: { id: true, full_name: true, role: true },
          },
          lots: { select: { lot_code: true } },
        },
      }),
      this.prisma.commande_b2b.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Liste les documents export pour une commande B2B donnée.
   * Vérifie d'abord que l'exporter en est bien le propriétaire.
   */
  async listExportDocs(exporterId: string, commandeB2bId: string) {
    const owns = await this.prisma.commande_b2b.findFirst({
      where: { id: commandeB2bId, exporter_id: exporterId },
      select: { id: true },
    });
    if (!owns) return [];

    return this.prisma.export_documents.findMany({
      where: { commande_b2b_id: commandeB2bId },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Liste les offres B2B publiées par cet exporter.
   */
  async listMyOffres(exporterId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = { exporter_id: exporterId };

    const [data, total] = await Promise.all([
      this.prisma.offres_marche_b2b.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.offres_marche_b2b.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }
}
