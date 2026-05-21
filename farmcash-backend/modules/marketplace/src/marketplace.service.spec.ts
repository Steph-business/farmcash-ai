// =====================================================================
//  UNIT : MarketplaceService — Chantier 5
//  ---------------------------------------------------------------------
//  Verrou coop_status : tant qu'une annonce est PENDING, VALIDATED ou
//  INCLUDED côté coopérative, le farmer ne peut plus la modifier ni la
//  supprimer (la coop est responsable de l'inventaire).
// =====================================================================

import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { CooperativesService } from '@farmcash/cooperatives';
import { MarketplaceService } from './marketplace.service';

function buildPrismaMock() {
  return {
    annonces_vente: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

function buildCoopServiceMock(): CooperativesService {
  return { attachAnnonceToCoop: jest.fn() } as any;
}

describe('MarketplaceService — verrou coop_status', () => {
  const ANNONCE_ID = '11111111-1111-1111-1111-111111111111';
  const FARMER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  let prisma: any;
  let coops: CooperativesService;
  let service: MarketplaceService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    coops = buildCoopServiceMock();
    service = new MarketplaceService(prisma as unknown as PrismaService, coops);
  });

  for (const status of ['PENDING', 'VALIDATED', 'INCLUDED'] as const) {
    it(`updateAnnonceVente refuse coop_status=${status} (BadRequestException)`, async () => {
      prisma.annonces_vente.findFirst.mockResolvedValueOnce({
        id: ANNONCE_ID,
        farmer_id: FARMER_ID,
        coop_status: status,
      });

      await expect(
        service.updateAnnonceVente(FARMER_ID, ANNONCE_ID, { titre: 'nouveau' }),
      ).rejects.toThrow(BadRequestException);

      // L'update DB n'a pas dû être appelé.
      expect(prisma.annonces_vente.update).not.toHaveBeenCalled();
    });

    it(`deleteAnnonceVente refuse coop_status=${status}`, async () => {
      prisma.annonces_vente.findFirst.mockResolvedValueOnce({
        id: ANNONCE_ID,
        farmer_id: FARMER_ID,
        coop_status: status,
      });

      await expect(
        service.deleteAnnonceVente(FARMER_ID, ANNONCE_ID),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.annonces_vente.delete).not.toHaveBeenCalled();
    });
  }

  it('updateAnnonceVente accepte coop_status=null (annonce libre)', async () => {
    prisma.annonces_vente.findFirst.mockResolvedValueOnce({
      id: ANNONCE_ID,
      farmer_id: FARMER_ID,
      coop_status: null,
    });

    const result = await service.updateAnnonceVente(FARMER_ID, ANNONCE_ID, {
      titre: 'modifié',
    });

    expect(prisma.annonces_vente.update).toHaveBeenCalled();
    expect(result).toMatchObject({ message: expect.stringContaining('modifiée') });
  });

  it("updateAnnonceVente accepte coop_status=REJECTED (la coop a refusé → farmer libre)", async () => {
    prisma.annonces_vente.findFirst.mockResolvedValueOnce({
      id: ANNONCE_ID,
      farmer_id: FARMER_ID,
      coop_status: 'REJECTED',
    });

    await service.updateAnnonceVente(FARMER_ID, ANNONCE_ID, { titre: 'libéré' });

    expect(prisma.annonces_vente.update).toHaveBeenCalled();
  });
});
