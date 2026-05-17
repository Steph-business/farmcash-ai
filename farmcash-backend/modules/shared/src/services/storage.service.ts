// =====================================================================
//  StorageService — upload de fichiers vers MinIO (compatible S3).
//  ---------------------------------------------------------------------
//  Tout le code qui sauvegarde une image / preuve de livraison passe ici.
//  En prod, swap S3_ENDPOINT vers AWS S3 / Cloudflare R2 : aucune autre
//  ligne à toucher.
//
//  Variables .env requises :
//    S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET
//    MEDIA_PUBLIC_BASE_URL (optionnel) — base URL publique des objets
//      (ex. http://localhost:9000/farmcash en dev, https://cdn.farmcash.ci en prod)
// =====================================================================

import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

export interface UploadedAsset {
  url: string;
  thumbnail_url?: string;
  key: string;
  size: number;
  mime: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.getOrThrow<string>('S3_ENDPOINT');
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    // MinIO en dev = http://localhost:9000/<bucket>/<key>
    this.publicBaseUrl =
      this.config.get<string>('MEDIA_PUBLIC_BASE_URL') ??
      `${endpoint.replace(/\/$/, '')}/${this.bucket}`;

    this.client = new S3Client({
      endpoint,
      region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_KEY'),
      },
      // MinIO exige le path-style (bucket dans le chemin, pas le sous-domaine).
      forcePathStyle: true,
    });
  }

  /**
   * Garantit que le bucket existe + que les objets sont accessibles
   * publiquement en lecture (les URLs renvoyées sont des URLs « plain »
   * sans signature → simplifie l'affichage côté mobile).
   */
  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      this.logger.log(`Bucket "${this.bucket}" absent — création.`);
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    // Politique lecture publique (idempotent : OK de la rejouer)
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
        },
      ],
    });
    try {
      await this.client.send(
        new PutBucketPolicyCommand({ Bucket: this.bucket, Policy: policy }),
      );
    } catch (e) {
      this.logger.warn(
        `Impossible d'appliquer la bucket policy public-read: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Pousse un buffer (typiquement un Multer file) sous une clé organisée
   * par dossier logique. Retourne l'URL publique.
   */
  async upload(
    folder: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ): Promise<UploadedAsset> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Fichier vide.');
    }
    const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, '');
    const ext = extname(file.originalname).toLowerCase() || guessExt(file.mimetype);
    const key = `${safeFolder}/${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return {
      key,
      url: `${this.publicBaseUrl}/${key}`,
      size: file.size,
      mime: file.mimetype,
    };
  }
}

function guessExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'video/mp4':
      return '.mp4';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}
