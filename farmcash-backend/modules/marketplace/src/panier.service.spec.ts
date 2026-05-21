// =====================================================================
//  UNIT : PanierService — Chantier 5
//  ---------------------------------------------------------------------
//  Vérifie qu'ajouter 2x le même article cumule la quantité via
//  l'upsert atomique (panier_id, annonce_id) — pas de duplication.
// =====================================================================

import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { PanierService } from './panier.service';

function decimal(value: number | string): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

function buildPrismaMock() {
  const annonces_vente = {
    findUnique: jest.fn(),
  };
  const panier = {
    upsert: jest.fn().mockResolvedValue({ id: 'panier-1', user_id: 'u-1' }),
  };
  const panier_items = {
    upsert: jest.fn(),
  };
  const $transaction = jest.fn(async (cb: any) =>
    cb({ panier, panier_items }),
  );
  return { annonces_vente, panier, panier_items, $transaction } as any;
}

describe('PanierService — ajouterArticle (cumul via upsert atomique)', () => {
  const ANNONCE_ID = '11111111-1111-1111-1111-111111111111';
  const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const FARMER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  let prisma: any;
  let service: PanierService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new PanierService(prisma as unknown as PrismaService);
  });

  function mockAnnonceActive(stockKg: number = 500, minKg: number = 10) {
    prisma.annonces_vente.findUnique.mockResolvedValue({
      id: ANNONCE_ID,
      status: 'ACTIVE',
      prix_par_kg: decimal(500),
      quantite_kg: decimal(stockKg),
      quantite_min_kg: decimal(minKg),
      farmer_id: FARMER_ID,
    });
  }

  it('ajout 2x du même item → upsert avec increment cumulé sur quantite_kg', async () => {
    mockAnnonceActive();

    // 1er ajout : 50kg → upsert renvoie qty=50
    prisma.panier_items.upsert.mockResolvedValueOnce({
      id: 'item-1',
      quantite_kg: decimal(50),
    });
    await service.ajouterArticle(USER_ID, {
      annonce_id: ANNONCE_ID,
      quantite_kg: 50,
    });

    // 2e ajout : 30kg → upsert renvoie qty=80 (cumul)
    prisma.panier_items.upsert.mockResolvedValueOnce({
      id: 'item-1',
      quantite_kg: decimal(80),
    });
    await service.ajouterArticle(USER_ID, {
      annonce_id: ANNONCE_ID,
      quantite_kg: 30,
    });

    expect(prisma.panier_items.upsert).toHaveBeenCalledTimes(2);
    // 2e appel : la branche update doit utiliser { increment: quantite_kg }
    const secondCall = prisma.panier_items.upsert.mock.calls[1][0];
    expect(secondCall.update).toMatchObject({
      quantite_kg: { increment: 30 },
    });
    // La création utilise bien le prix relu côté serveur (anti-tamper).
    expect(secondCall.create.prix_unitaire).toEqual(decimal(500));
  });

  it("dépasse le stock cumulé → rollback via BadRequestException", async () => {
    mockAnnonceActive(100); // stock 100kg

    // 1er ajout 60kg → ok
    prisma.panier_items.upsert.mockResolvedValueOnce({
      id: 'item-1',
      quantite_kg: decimal(60),
    });
    await service.ajouterArticle(USER_ID, {
      annonce_id: ANNONCE_ID,
      quantite_kg: 60,
    });

    // 2e ajout 60kg → cumul 120kg > stock 100 → l'upsert renvoie qty=120
    // et la garde anti-overshoot doit throw.
    prisma.panier_items.upsert.mockResolvedValueOnce({
      id: 'item-1',
      quantite_kg: decimal(120),
    });
    await expect(
      service.ajouterArticle(USER_ID, {
        annonce_id: ANNONCE_ID,
        quantite_kg: 60,
      }),
    ).rejects.toThrow(/cumulée supérieure au stock/);
  });
});
