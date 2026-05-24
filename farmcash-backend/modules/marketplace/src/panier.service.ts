// =====================================================================
//  SERVICE : PanierService
//  ---------------------------------------------------------------------
//  Gère le panier d'achat (tables `panier` + `panier_items`).
//
//  ⚠️ SÉCURITÉ — Le `prix_unitaire` est TOUJOURS relu depuis l'annonce
//  côté serveur. Le client ne peut PAS imposer son propre prix dans
//  le body de la requête.
// =====================================================================

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { product_status } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { AjouterPanierDto } from './dto/panier.dto';

@Injectable()
export class PanierService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne le panier de l'utilisateur. Le crée à la volée s'il
   * n'existe pas — un seul panier par user (contrainte UNIQUE user_id).
   */
  async getMonPanier(userId: string) {
    // Include annonces_vente *complet* avec ses relations jointes
    // (produits_agricoles, users vendeur, regions_ci, villes_ci, medias).
    // L'UI mobile (`PanierItem.annonce`) attend l'objet complet pour
    // afficher photo / vendeur / localisation / prix sur les cards
    // du panier — un select restreint fait crasher le parser freezed.
    const include = {
      panier_items: {
        include: {
          annonces_vente: {
            include: {
              produits_agricoles: { select: { nom: true, unite_mesure: true } },
              users: {
                select: { id: true, full_name: true, rating: true, photo_url: true },
              },
              regions_ci: { select: { nom: true } },
              villes_ci: { select: { nom: true } },
              medias: { select: { url: true, thumbnail_url: true }, take: 3 },
            },
          },
        },
      },
    } as const;

    let panier = await this.prisma.panier.findUnique({
      where: { user_id: userId },
      include,
    });

    if (!panier) {
      panier = await this.prisma.panier.create({
        data: { user_id: userId },
        include,
      });
    }

    return panier;
  }

  /**
   * Ajoute (ou cumule) un article au panier.
   *
   * Étapes :
   *   1. Récupère l'annonce ; refuse si inexistante ou non ACTIVE.
   *   2. Vérifie que la quantité demandée respecte le min de l'annonce
   *      ET ne dépasse pas le stock disponible.
   *   3. Récupère le prix unitaire depuis l'annonce (le DTO n'a pas
   *      le droit de l'imposer).
   *   4. Dans une transaction : upsert du panier + add/update de l'item.
   */
  async ajouterArticle(userId: string, dto: AjouterPanierDto) {
    const annonce = await this.prisma.annonces_vente.findUnique({
      where: { id: dto.annonce_id },
      select: {
        id: true,
        status: true,
        prix_par_kg: true,
        quantite_kg: true,
        quantite_min_kg: true,
        farmer_id: true,
      },
    });

    if (!annonce || annonce.status !== product_status.ACTIVE) {
      throw new NotFoundException('Annonce introuvable ou non active.');
    }
    if (annonce.farmer_id === userId) {
      throw new BadRequestException('Vous ne pouvez pas acheter votre propre annonce.');
    }
    if (dto.quantite_kg < annonce.quantite_min_kg.toNumber()) {
      throw new BadRequestException(
        `Quantité minimale par commande : ${annonce.quantite_min_kg} kg.`,
      );
    }
    if (dto.quantite_kg > annonce.quantite_kg.toNumber()) {
      throw new BadRequestException(
        `Quantité demandée supérieure au stock (${annonce.quantite_kg} kg).`,
      );
    }

    // Transaction : panier + item. L'upsert s'appuie sur la contrainte
    // unique (panier_id, annonce_id) — atomique côté DB, élimine la
    // race condition findFirst+update. On vérifie ensuite que la qty
    // cumulée ne dépasse pas le stock ; si oui on rollback via throw.
    return this.prisma.$transaction(async (tx) => {
      const panier = await tx.panier.upsert({
        where: { user_id: userId },
        update: {},
        create: { user_id: userId },
      });

      const item = await tx.panier_items.upsert({
        where: {
          panier_id_annonce_id: {
            panier_id: panier.id,
            annonce_id: dto.annonce_id,
          },
        },
        create: {
          panier_id: panier.id,
          annonce_id: dto.annonce_id,
          quantite_kg: dto.quantite_kg,
          // Prix relu de l'annonce côté serveur — le client ne décide pas.
          prix_unitaire: annonce.prix_par_kg,
        },
        update: {
          quantite_kg: { increment: dto.quantite_kg },
          // Realign le prix sur la valeur actuelle de l'annonce (anti-
          // stale price si l'annonce a été mise à jour entre 2 ajouts).
          prix_unitaire: annonce.prix_par_kg,
        },
      });

      // Anti-overshoot stock : si la qty cumulée dépasse le stock, on
      // rollback la transaction.
      if (item.quantite_kg.toNumber() > annonce.quantite_kg.toNumber()) {
        throw new BadRequestException('Quantité cumulée supérieure au stock.');
      }

      return { message: 'Article ajouté au panier avec succès.' };
    });
  }

  /**
   * Retire un item du panier. Filtré par ownership via `panier.user_id`.
   */
  async supprimerArticle(userId: string, itemId: string) {
    const panier = await this.prisma.panier.findUnique({
      where: { user_id: userId },
    });
    if (!panier) throw new NotFoundException('Panier introuvable.');

    const result = await this.prisma.panier_items.deleteMany({
      where: { id: itemId, panier_id: panier.id },
    });
    if (result.count === 0) {
      throw new NotFoundException('Article introuvable dans votre panier.');
    }
    return { message: 'Article retiré du panier.' };
  }
}
