// =====================================================================
//  ENTITY : AnnonceVenteEntity
//  Représentation TypeScript d'une annonce de vente pour le front-end.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AnnonceVenteEntity {
  @ApiProperty({ example: 'uuid-annonce' })
  id: string;

  @ApiProperty({ example: 'uuid-farmer' })
  farmer_id: string;

  @ApiPropertyOptional({ example: 'uuid-produit' })
  produit_id?: string;

  @ApiProperty({ example: 'Maïs grain blanc bien sec — récolte mars 2026' })
  titre: string;

  @ApiPropertyOptional({ example: 'Description complète...' })
  description?: string;

  @ApiProperty({ example: 500, description: 'Quantité totale (KG)' })
  quantite_kg: number;

  @ApiProperty({ example: 1000, description: 'Prix au KG (FCFA)' })
  prix_par_kg: number;

  @ApiProperty({ example: 50, description: 'Commande minimale (KG)' })
  quantite_min_kg: number;

  @ApiProperty({ example: 'STANDARD' })
  qualite: string;

  @ApiProperty({ example: 'DRAFT', enum: ['DRAFT', 'PUBLISHED', 'SOLD_OUT', 'CANCELLED'] })
  status: string;

  @ApiProperty({ example: 120 })
  views_count: number;

  @ApiProperty({ example: '2025-01-15T10:30:00Z' })
  created_at: Date;

  // Relations incluses (si demandées)
  produit?: any; // détails du produit agricole
  vendeur?: any; // infos de base du vendeur (nom, note)
  medias?: any[]; // photos de l'annonce
}
