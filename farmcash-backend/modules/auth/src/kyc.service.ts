// =====================================================================
//  SERVICE : KycService
//  ---------------------------------------------------------------------
//  Gère le cycle de vie des documents KYC :
//   • upload → row PENDING + fichier sur MinIO
//   • lecture des documents du user (mes documents)
//   • suppression uniquement si statut PENDING
//
//  Validation/rejet : assurés par les ADMIN via le module oversight
//  (hors scope de ce service).
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { StorageService } from '@farmcash/shared';
import { KycDocType } from './dto/kyc.dto';

@Injectable()
export class KycService {
  private static readonly MAX_FILE_SIZE = 10 * 1024 * 1024;
  private static readonly ALLOWED_MIMES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'application/pdf',
  ]);

  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Liste les documents KYC du user, du plus récent au plus ancien. */
  async listMine(userId: string) {
    return this.prisma.kyc_documents.findMany({
      where: { user_id: userId },
      orderBy: { uploaded_at: 'desc' },
    });
  }

  /**
   * Upload + création de la row. Validation MIME + taille AVANT
   * d'ouvrir la connexion MinIO. Le fichier est rangé sous
   * `kyc/<user_id>/<random>.ext`.
   */
  async upload(
    userId: string,
    docType: KycDocType,
    file: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    if (!file) throw new BadRequestException('Aucun fichier reçu.');

    if (!KycService.ALLOWED_MIMES.has(file.mimetype)) {
      throw new BadRequestException(
        `Type MIME non supporté: ${file.mimetype}. Attendu: ${Array.from(KycService.ALLOWED_MIMES).join(', ')}.`,
      );
    }
    if (file.size > KycService.MAX_FILE_SIZE) {
      throw new BadRequestException(
        `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo, max ${KycService.MAX_FILE_SIZE / 1024 / 1024} Mo).`,
      );
    }

    const asset = await this.storage.upload(`kyc/${userId}`, file);

    const created = await this.prisma.kyc_documents.create({
      data: {
        user_id: userId,
        doc_type: docType,
        url: asset.url,
        status: 'PENDING',
      },
    });

    this.logger.log(
      `KYC ${docType} uploadé ${created.id} pour ${userId} (${asset.key})`,
    );
    return {
      message: 'Document KYC reçu — en attente de validation.',
      id: created.id,
      url: asset.url,
      status: 'PENDING',
    };
  }

  /**
   * Suppression uniquement si PENDING.
   * Si déjà VALIDATED ou REJECTED → ConflictException (l'admin a
   * statué, l'utilisateur ne peut plus l'effacer pour préserver
   * l'audit trail).
   */
  async remove(userId: string, id: string) {
    const doc = await this.prisma.kyc_documents.findFirst({
      where: { id, user_id: userId },
    });
    if (!doc) throw new NotFoundException('Document introuvable.');
    if (doc.status !== 'PENDING') {
      throw new ConflictException(
        `Document en statut ${doc.status} — suppression impossible.`,
      );
    }
    await this.prisma.kyc_documents.delete({ where: { id } });
    this.logger.log(`KYC supprimé ${id} (user ${userId})`);
    return { message: 'Document KYC supprimé.' };
  }
}
