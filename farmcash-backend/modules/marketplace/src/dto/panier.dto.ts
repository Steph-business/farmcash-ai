// =====================================================================
//  DTO : AjouterPanierDto
//  ---------------------------------------------------------------------
//  POST /marketplace/panier/add
//
//  ⚠️ SÉCURITÉ : le `prix_unitaire` n'est PAS dans ce DTO. Il est
//  systématiquement relu depuis l'annonce côté serveur (cf.
//  PanierService.ajouterArticle). Cela empêche un acheteur de poster
//  son propre prix dans le panier et de générer une commande à 1 FCFA/kg.
// =====================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsUUID, Min } from 'class-validator';

export class AjouterPanierDto {
  @ApiProperty({ example: 'uuid-annonce-vente' })
  @IsUUID()
  @IsNotEmpty()
  annonce_id: string;

  @ApiProperty({ example: 50, description: 'Quantité voulue en KG' })
  @IsNumber()
  @Min(1)
  quantite_kg: number;
}
