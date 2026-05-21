// =====================================================================
//  SERVICE : BuyerAddressesService
//  ---------------------------------------------------------------------
//  Gère le carnet d'adresses du BUYER :
//   • multi-adresses (Domicile, Restaurant, Entrepôt...)
//   • is_default : 1 seule adresse "défaut" par user — débadge des
//     autres en transaction si on en désigne une nouvelle
//   • soft delete : on garde is_active=false pour préserver l'intégrité
//     référentielle des commandes passées avec cette adresse
// =====================================================================

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import {
  CreateBuyerAddressDto,
  UpdateBuyerAddressDto,
} from './dto/buyer-addresses.dto';

@Injectable()
export class BuyerAddressesService {
  private readonly logger = new Logger(BuyerAddressesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Liste les adresses actives du BUYER. Adresse "défaut" en tête. */
  async list(userId: string) {
    return this.prisma.buyer_addresses.findMany({
      where: { user_id: userId, is_active: true },
      include: {
        villes_ci: { select: { id: true, nom: true } },
      },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    });
  }

  /**
   * Crée une adresse. Si is_default=true, débadge toutes les autres
   * adresses du même user en transaction (1 seule défaut par user).
   * Si c'est la 1ère adresse du user, on la force à is_default.
   */
  async create(userId: string, dto: CreateBuyerAddressDto) {
    const setDefault =
      dto.is_default ??
      (await this.prisma.buyer_addresses.count({
        where: { user_id: userId, is_active: true },
      })) === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      if (setDefault) {
        await tx.buyer_addresses.updateMany({
          where: { user_id: userId, is_default: true },
          data: { is_default: false },
        });
      }
      return tx.buyer_addresses.create({
        data: {
          user_id: userId,
          libelle: dto.libelle,
          contact_nom: dto.contact_nom,
          contact_phone: dto.contact_phone,
          adresse_complete: dto.adresse_complete,
          ville_id: dto.ville_id,
          lat: dto.lat,
          lng: dto.lng,
          is_default: setDefault,
        },
      });
    });

    this.logger.log(`Adresse buyer créée ${created.id} pour ${userId}`);
    return { message: 'Adresse enregistrée.', id: created.id, address: created };
  }

  /**
   * Modifie une adresse. Vérifie ownership (404 sinon — pas de fuite
   * d'info sur l'existence d'IDs étrangers).
   */
  async update(userId: string, id: string, dto: UpdateBuyerAddressDto) {
    const address = await this.prisma.buyer_addresses.findFirst({
      where: { id, user_id: userId, is_active: true },
    });
    if (!address) throw new NotFoundException('Adresse introuvable.');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.is_default === true) {
        await tx.buyer_addresses.updateMany({
          where: { user_id: userId, is_default: true, id: { not: id } },
          data: { is_default: false },
        });
      }
      return tx.buyer_addresses.update({
        where: { id },
        data: {
          ...(dto.libelle !== undefined && { libelle: dto.libelle }),
          ...(dto.contact_nom !== undefined && { contact_nom: dto.contact_nom }),
          ...(dto.contact_phone !== undefined && {
            contact_phone: dto.contact_phone,
          }),
          ...(dto.adresse_complete !== undefined && {
            adresse_complete: dto.adresse_complete,
          }),
          ...(dto.ville_id !== undefined && { ville_id: dto.ville_id }),
          ...(dto.lat !== undefined && { lat: dto.lat }),
          ...(dto.lng !== undefined && { lng: dto.lng }),
          ...(dto.is_default !== undefined && { is_default: dto.is_default }),
          updated_at: new Date(),
        },
      });
    });

    this.logger.log(`Adresse buyer modifiée ${id}`);
    return { message: 'Adresse mise à jour.', id, address: updated };
  }

  /**
   * Soft delete (is_active=false) — préserve l'historique commandes.
   * Si on supprime l'adresse défaut, on en désigne une autre par défaut
   * si possible.
   */
  async remove(userId: string, id: string) {
    const address = await this.prisma.buyer_addresses.findFirst({
      where: { id, user_id: userId, is_active: true },
    });
    if (!address) throw new NotFoundException('Adresse introuvable.');

    await this.prisma.$transaction(async (tx) => {
      await tx.buyer_addresses.update({
        where: { id },
        data: { is_active: false, is_default: false, updated_at: new Date() },
      });

      // Si on a retiré le default, on en désigne un autre arbitrairement
      if (address.is_default) {
        const fallback = await tx.buyer_addresses.findFirst({
          where: { user_id: userId, is_active: true, id: { not: id } },
          orderBy: { created_at: 'desc' },
        });
        if (fallback) {
          await tx.buyer_addresses.update({
            where: { id: fallback.id },
            data: { is_default: true },
          });
        }
      }
    });

    this.logger.log(`Adresse buyer désactivée ${id}`);
    return { message: 'Adresse supprimée.' };
  }
}
