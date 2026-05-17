// =====================================================================
//  SERVICE : InteractionsService
//  ---------------------------------------------------------------------
//  Gère les favoris, les avis (rating + commentaire) et les médias
//  attachés aux annonces / publications / lots.
//
//  Règles métier importantes :
//   • Favoris : contrainte UNIQUE (user_id, annonce_id) en DB → on
//     utilise un upsert et on intercepte P2002 si jamais une race
//     l'enfreint.
//   • Avis : un user ne peut pas s'auto-noter ; il doit y avoir une
//     commande COMPLETED entre les deux ; un seul avis par (reviewer,
//     annonce).
//   • Médias : l'ajout/suppression nécessite d'être propriétaire de
//     l'objet cible (annonce / publication / lot).
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { order_status, Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { StorageService } from '@farmcash/shared';
import {
  AddAvisDto,
  AddFavoriDto,
  AddMediaDto,
  MediaKind,
  MediaTargetType,
} from './dto/interactions.dto';

@Injectable()
export class InteractionsService {
  /**
   * Plafonds upload — image=10 Mo, vidéo=80 Mo. Au-delà on rejette en
   * BadRequest avant même d'ouvrir une connexion MinIO.
   */
  private static readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024;
  private static readonly MAX_VIDEO_SIZE = 80 * 1024 * 1024;
  private static readonly ALLOWED_IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
  ]);
  private static readonly ALLOWED_VIDEO_MIMES = new Set([
    'video/mp4',
    'video/quicktime',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ===================================================================
  //  FAVORIS
  // ===================================================================

  async getMesFavoris(userId: string) {
    return this.prisma.favoris.findMany({
      where: { user_id: userId },
      include: {
        annonces_vente: {
          select: { id: true, titre: true, prix_par_kg: true, status: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Ajoute ou retire l'annonce des favoris. Utilise la contrainte
   * UNIQUE (user_id, annonce_id) pour éviter les doublons en
   * cas de double-clic rapide.
   */
  async toggleFavori(userId: string, dto: AddFavoriDto) {
    const annonce = await this.prisma.annonces_vente.findUnique({
      where: { id: dto.annonce_id },
      select: { id: true },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable.');

    try {
      await this.prisma.favoris.create({
        data: { user_id: userId, annonce_id: dto.annonce_id },
      });
      return { message: 'Ajouté aux favoris.', favori: true };
    } catch (e) {
      // P2002 = violation de la contrainte UNIQUE → favori déjà présent
      // → on le supprime (toggle off).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.favoris.delete({
          where: {
            user_id_annonce_id: {
              user_id: userId,
              annonce_id: dto.annonce_id,
            },
          },
        });
        return { message: 'Retiré des favoris.', favori: false };
      }
      throw e;
    }
  }

  // ===================================================================
  //  AVIS
  // ===================================================================

  /**
   * Laisse un avis sur une annonce. Quatre garde-fous :
   *   1. L'annonce existe.
   *   2. L'auteur de l'avis n'est pas le vendeur (pas d'auto-review).
   *   3. Il existe une commande COMPLETED entre buyer (reviewer) et
   *      seller (annonce.farmer_id) sur cette annonce.
   *   4. Pas déjà d'avis du même reviewer sur cette annonce.
   */
  async laisserAvis(userId: string, dto: AddAvisDto) {
    const annonce = await this.prisma.annonces_vente.findUnique({
      where: { id: dto.annonce_id },
      select: { id: true, farmer_id: true },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable.');

    if (annonce.farmer_id === userId) {
      throw new BadRequestException('Vous ne pouvez pas vous auto-évaluer.');
    }

    const commandeOk = await this.prisma.commandes_vente.findFirst({
      where: {
        annonce_id: dto.annonce_id,
        buyer_id: userId,
        seller_id: annonce.farmer_id,
        status: { in: [order_status.DELIVERED, order_status.COMPLETED] },
      },
      select: { id: true },
    });
    if (!commandeOk) {
      throw new ForbiddenException(
        'Vous devez avoir une commande livrée sur cette annonce pour laisser un avis.',
      );
    }

    const dejaUnAvis = await this.prisma.avis.findFirst({
      where: {
        reviewer_id: userId,
        context_type: 'ANNONCE_VENTE',
        context_id: dto.annonce_id,
      },
      select: { id: true },
    });
    if (dejaUnAvis) {
      throw new ConflictException('Vous avez déjà laissé un avis sur cette annonce.');
    }

    const avis = await this.prisma.avis.create({
      data: {
        reviewer_id: userId,
        reviewed_user_id: annonce.farmer_id,
        context_type: 'ANNONCE_VENTE',
        context_id: dto.annonce_id,
        note: dto.rating,
        commentaire: dto.commentaire,
      },
    });
    return { message: 'Avis enregistré.', id: avis.id };
  }

  /**
   * Supprime son propre avis (filtré par reviewer_id).
   */
  async deleteAvis(userId: string, id: string) {
    const avis = await this.prisma.avis.findFirst({
      where: { id, reviewer_id: userId },
    });
    if (!avis) throw new NotFoundException('Avis introuvable.');
    await this.prisma.avis.delete({ where: { id } });
    return { message: 'Avis supprimé.' };
  }

  // ===================================================================
  //  MÉDIAS
  // ===================================================================

  /**
   * Ajoute un média (image/vidéo/document) à une annonce, une
   * publication coopérative, ou un lot. Le service vérifie que
   * l'utilisateur est propriétaire de la cible.
   */
  async addMedia(userId: string, coopId: string | null, dto: AddMediaDto) {
    await this.assertOwnsTarget(userId, coopId, dto.target_type, dto.target_id);

    const media = await this.prisma.medias.create({
      data: {
        annonce_vente_id:
          dto.target_type === MediaTargetType.ANNONCE_VENTE ? dto.target_id : null,
        publication_coop_id:
          dto.target_type === MediaTargetType.PUBLICATION_COOP ? dto.target_id : null,
        lot_id: dto.target_type === MediaTargetType.LOT ? dto.target_id : null,
        url: dto.url,
        thumbnail_url: dto.thumbnail_url,
        media_type: dto.type,
      },
    });
    return { message: 'Média ajouté.', id: media.id };
  }

  /**
   * Upload « tout-en-un » : on reçoit un fichier multipart, on le pousse
   * vers MinIO, puis on insère la row `medias` avec l'URL publique.
   * Évite au mobile de devoir orchestrer 2 appels (upload puis register).
   */
  async uploadMedia(
    userId: string,
    coopId: string | null,
    file: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
    targetType: MediaTargetType,
    targetId: string,
    kind: MediaKind = MediaKind.IMAGE,
  ) {
    if (!file) throw new BadRequestException('Aucun fichier reçu.');

    // Validation MIME + taille avant d'ouvrir la connexion MinIO.
    const allowed =
      kind === MediaKind.VIDEO
        ? InteractionsService.ALLOWED_VIDEO_MIMES
        : InteractionsService.ALLOWED_IMAGE_MIMES;
    if (!allowed.has(file.mimetype)) {
      throw new BadRequestException(
        `Type MIME non supporté: ${file.mimetype}. Attendu: ${Array.from(allowed).join(', ')}.`,
      );
    }
    const maxSize =
      kind === MediaKind.VIDEO
        ? InteractionsService.MAX_VIDEO_SIZE
        : InteractionsService.MAX_IMAGE_SIZE;
    if (file.size > maxSize) {
      throw new BadRequestException(
        `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo, max ${maxSize / 1024 / 1024} Mo).`,
      );
    }

    // Ownership AVANT upload — pas de fichier orphelin si l'user n'a pas les droits.
    await this.assertOwnsTarget(userId, coopId, targetType, targetId);

    const folder =
      targetType === MediaTargetType.ANNONCE_VENTE
        ? `annonces/${targetId}`
        : targetType === MediaTargetType.PUBLICATION_COOP
          ? `publications/${targetId}`
          : `lots/${targetId}`;

    const asset = await this.storage.upload(folder, file);

    const media = await this.prisma.medias.create({
      data: {
        annonce_vente_id:
          targetType === MediaTargetType.ANNONCE_VENTE ? targetId : null,
        publication_coop_id:
          targetType === MediaTargetType.PUBLICATION_COOP ? targetId : null,
        lot_id: targetType === MediaTargetType.LOT ? targetId : null,
        url: asset.url,
        thumbnail_url: asset.url,
        media_type: kind,
      },
    });

    return {
      message: 'Média uploadé.',
      id: media.id,
      url: asset.url,
      thumbnail_url: asset.url,
    };
  }

  /**
   * Supprime un média. On reconstruit la cible et on vérifie l'ownership.
   */
  async deleteMedia(userId: string, coopId: string | null, id: string) {
    const media = await this.prisma.medias.findUnique({ where: { id } });
    if (!media) throw new NotFoundException('Média introuvable.');

    const targetType: MediaTargetType | null = media.annonce_vente_id
      ? MediaTargetType.ANNONCE_VENTE
      : media.publication_coop_id
        ? MediaTargetType.PUBLICATION_COOP
        : media.lot_id
          ? MediaTargetType.LOT
          : null;
    const targetId =
      media.annonce_vente_id ?? media.publication_coop_id ?? media.lot_id;
    if (!targetType || !targetId) {
      throw new BadRequestException('Média sans cible identifiable.');
    }

    await this.assertOwnsTarget(userId, coopId, targetType, targetId);
    await this.prisma.medias.delete({ where: { id } });
    return { message: 'Média supprimé.' };
  }

  // -------------------------------------------------------------------
  //  Helpers privés
  // -------------------------------------------------------------------

  /**
   * Vérifie que `userId` (et éventuellement `coopId` pour les publications
   * coopératives ou les lots COOP) est bien propriétaire de l'objet cible.
   * Lève ForbiddenException sinon.
   */
  private async assertOwnsTarget(
    userId: string,
    coopId: string | null,
    targetType: MediaTargetType,
    targetId: string,
  ): Promise<void> {
    switch (targetType) {
      case MediaTargetType.ANNONCE_VENTE: {
        const ok = await this.prisma.annonces_vente.findFirst({
          where: { id: targetId, farmer_id: userId },
          select: { id: true },
        });
        if (!ok) throw new ForbiddenException("Vous n'êtes pas propriétaire de l'annonce.");
        return;
      }
      case MediaTargetType.PUBLICATION_COOP: {
        if (!coopId) throw new ForbiddenException('Compte non rattaché à une coopérative.');
        const ok = await this.prisma.publications_stock_coop.findFirst({
          where: { id: targetId, cooperative_id: coopId },
          select: { id: true },
        });
        if (!ok) throw new ForbiddenException("Publication non rattachée à votre coopérative.");
        return;
      }
      case MediaTargetType.LOT: {
        const ok = await this.prisma.lots.findFirst({
          where: {
            id: targetId,
            OR: [
              { farmer_id: userId },
              ...(coopId ? [{ cooperative_id: coopId }] : []),
            ],
          },
          select: { id: true },
        });
        if (!ok) throw new ForbiddenException("Vous n'êtes pas propriétaire du lot.");
        return;
      }
    }
  }
}
