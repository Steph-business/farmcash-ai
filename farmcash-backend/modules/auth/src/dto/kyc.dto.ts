// =====================================================================
//  DTOs : Documents KYC
//  ---------------------------------------------------------------------
//  Un user peut uploader plusieurs documents KYC (CNI recto/verso,
//  selfie, carte de producteur, justificatif parcelle...). Chacun a
//  un statut PENDING/VALIDATED/REJECTED et peut être supprimé tant
//  qu'il est PENDING.
// =====================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum KycDocType {
  CNI_RECTO = 'CNI_RECTO',
  CNI_VERSO = 'CNI_VERSO',
  CARTE_PRODUCTEUR = 'CARTE_PRODUCTEUR',
  SELFIE = 'SELFIE',
  JUSTIFICATIF_PARCELLE = 'JUSTIFICATIF_PARCELLE',
  PERMIS_CONDUIRE = 'PERMIS_CONDUIRE',
  CARTE_GRISE = 'CARTE_GRISE',
  RCCM = 'RCCM',
  AGREMENT = 'AGREMENT',
}

/**
 * Body multipart du POST /auth/kyc/upload.
 * Le fichier arrive via @UploadedFile() ; ce DTO ne porte que la nature
 * du document.
 */
export class UploadKycDocumentDto {
  @ApiProperty({ enum: KycDocType, description: 'Nature du document' })
  @IsEnum(KycDocType)
  doc_type: KycDocType;
}
