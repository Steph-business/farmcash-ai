// =====================================================================
//  ENTITY : UserEntity
//  Représentation TypeScript de la table "users" en base de données.
//  C'est ce qu'on retourne à l'API après avoir lu dans la DB.
//  On EXCLUT toujours pin_hash (jamais envoyé au client).
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserEntity {
  @ApiProperty({ example: 'uuid-utilisateur' })
  id: string;

  @ApiProperty({ example: '+2250709123456' })
  phone: string;

  @ApiProperty({ example: 'FARMER', enum: ['FARMER','BUYER','COOPERATIVE','TRANSPORTER','EXPORTER','ADMIN'] })
  role: string;

  @ApiProperty({ example: 'Koffi Aya' })
  full_name: string;

  @ApiPropertyOptional({ example: 'https://storage.farmcash.ci/photos/koffi.jpg' })
  photo_url?: string | null;

  @ApiProperty({ example: false })
  is_verified: boolean;

  @ApiProperty({ example: true })
  is_active: boolean;

  @ApiProperty({ example: 4.5, description: 'Note moyenne (0.00 à 5.00)' })
  rating: number;

  @ApiProperty({ example: 12, description: 'Nombre d\'avis reçus' })
  rating_count: number;

  @ApiPropertyOptional({ example: 50000.00, description: 'Solde du wallet en FCFA' })
  wallet_balance?: number;

  @ApiProperty({ example: 'fr', description: 'Langue préférée' })
  langue: string;

  @ApiProperty({ example: '2025-01-15T10:30:00Z' })
  created_at: Date;

  @ApiProperty({ example: '2025-03-20T14:15:00Z' })
  updated_at: Date;

  // Profils étendus — présents uniquement si chargés avec include Prisma
  producteur_profiles?: any;
  acheteur_profiles?: any;
  cooperative_profiles?: any;
  transporteur_profiles?: any;
  exportateur_profiles?: any;
  admin_profiles?: any;

  // On ne retourne JAMAIS le pin_hash au client
  // pin_hash est volontairement absent de cette entity
}
