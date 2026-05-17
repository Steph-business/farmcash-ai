// =====================================================================
//  SERVICE : AiNewsService
//  ---------------------------------------------------------------------
//  CRUD du fil d'actualité agricole. Trois usages :
//   • ADMIN : créer/modifier/désactiver des actualités (manuel ou via jobs).
//   • Tous : lire les news qui correspondent à leur rôle + région.
//
//  Filtrage automatique des news expirées et inactives.
// =====================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import {
  CreateNewsDto,
  ListNewsQueryDto,
  UpdateNewsDto,
} from './dto/news.dto';

@Injectable()
export class AiNewsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============== Lecture (tous rôles authentifiés) ==============

  /**
   * Liste les actualités visibles pour le user :
   *   • is_active = true
   *   • expires_at NULL ou > now
   *   • cible_role NULL ou matching le user.role
   *   • region_id NULL (nationale) ou matching la région du user
   */
  async listForUser(userId: string, query: ListNewsQueryDto) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { role: true /* region_id à raffiner via producteur_profiles */ },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const now = new Date();
    const where: Prisma.ai_newsWhereInput = {
      is_active: true,
      AND: [
        {
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
        {
          OR: [{ cible_role: null }, { cible_role: user.role }],
        },
      ],
      ...(query.type && { type: query.type }),
    };

    const [data, total] = await Promise.all([
      this.prisma.ai_news.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.ai_news.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  async getById(id: string) {
    const news = await this.prisma.ai_news.findUnique({ where: { id } });
    if (!news) throw new NotFoundException('Actualité introuvable.');
    return news;
  }

  // ============== CRUD ADMIN ==============

  async listAll(query: ListNewsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ai_newsWhereInput = {
      ...(query.type && { type: query.type }),
    };

    const [data, total] = await Promise.all([
      this.prisma.ai_news.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.ai_news.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  async create(adminId: string, dto: CreateNewsDto) {
    return this.prisma.ai_news.create({
      data: {
        type: dto.type,
        titre: dto.titre,
        body: dto.body,
        cible_role: dto.cible_role,
        region_id: dto.region_id,
        expires_at: dto.expires_at ? new Date(dto.expires_at) : undefined,
        is_active: true,
        created_by: adminId,
      },
    });
  }

  async update(id: string, dto: UpdateNewsDto) {
    await this.getById(id);
    return this.prisma.ai_news.update({
      where: { id },
      data: {
        ...(dto.titre !== undefined && { titre: dto.titre }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.cible_role !== undefined && { cible_role: dto.cible_role }),
        ...(dto.region_id !== undefined && { region_id: dto.region_id }),
        ...(dto.expires_at !== undefined && {
          expires_at: new Date(dto.expires_at),
        }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });
  }

  async delete(id: string) {
    await this.getById(id);
    await this.prisma.ai_news.update({
      where: { id },
      data: { is_active: false },
    });
    return { message: 'Actualité désactivée.' };
  }
}
