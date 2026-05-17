// =====================================================================
//  UNIT : MaskingService (Chantier 3)
//  ---------------------------------------------------------------------
//  Couvre :
//   • resolveVisibility() — table de décision rôle x relation
//   • maskPhone() / maskName() / maskGeo() — transformations atomiques
//   • Comportement MIN par défaut pour étrangers
//   • Comportement FULL pour ADMIN, self, TRANSPORTER avec shipment actif
//
//  Aucun mock externe : PrismaService est entièrement stubé avec des
//  Jest mocks (le service ne fait que des SELECTs ciblés).
// =====================================================================

import { MaskingService } from './masking.service';

/**
 * Stub minimaliste de PrismaService — uniquement les méthodes utilisées
 * par MaskingService (shipments, commandes_vente, cooperative_members).
 * On les implémente comme jest.fn() pour pouvoir piloter le retour par test.
 */
function createPrismaStub() {
  return {
    shipments: { findFirst: jest.fn() },
    commandes_vente: { findFirst: jest.fn() },
    cooperative_members: { findMany: jest.fn() },
  };
}

describe('MaskingService', () => {
  let service: MaskingService;
  let prisma: ReturnType<typeof createPrismaStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    // Pas de TwilioProxyService injecté → maskPhoneFor PARTIAL retombe
    // sur troncation (testé séparément côté E2E phone-proxy).
    service = new MaskingService(prisma as any);
  });

  // ===================================================================
  //  resolveVisibility — Table de décision rôle × relation
  // ===================================================================

  describe('resolveVisibility', () => {
    const VIEWER = 'viewer-id';
    const OBSERVED = 'observed-id';

    it('1. BUYER sans relation business → MIN (étranger)', async () => {
      // Aucun shipment, aucune commande active, aucune coop partagée.
      prisma.shipments.findFirst.mockResolvedValue(null);
      prisma.commandes_vente.findFirst.mockResolvedValue(null);
      prisma.cooperative_members.findMany.mockResolvedValue([]);

      const v = await service.resolveVisibility(VIEWER, 'BUYER', OBSERVED);
      expect(v).toBe('MIN');
    });

    it('2. TRANSPORTER avec shipment actif sur la commande de l\'observé → FULL', async () => {
      // Règle métier : le TRANSPORTER doit voir l'expéditeur/destinataire
      // en clair pour livrer correctement.
      prisma.shipments.findFirst.mockResolvedValue({ id: 'shipment-1' });
      // Les requêtes suivantes ne devraient pas être appelées (court-circuit).

      const v = await service.resolveVisibility(VIEWER, 'TRANSPORTER', OBSERVED);
      expect(v).toBe('FULL');
      // shipments check est la 1re requête pour TRANSPORTER → les autres
      // sélecteurs ne sont jamais consultés.
      expect(prisma.shipments.findFirst).toHaveBeenCalledTimes(1);
    });

    it('3a. FARMER ↔ co-membre FARMER même coop → PARTIAL (anti-contournement)', async () => {
      // Décision produit : les co-membres se connaissent IRL via les
      // réunions de la coop, mais le téléphone passe par proxy pour
      // limiter les transactions hors-plateforme.
      prisma.shipments.findFirst.mockResolvedValue(null);
      prisma.commandes_vente.findFirst.mockResolvedValue(null);
      const coopA = 'coop-A';
      prisma.cooperative_members.findMany.mockResolvedValue([
        { cooperative_id: coopA, member_id: VIEWER },
        { cooperative_id: coopA, member_id: OBSERVED },
      ]);

      const v = await service.resolveVisibility(VIEWER, 'FARMER', OBSERVED);
      expect(v).toBe('PARTIAL');
    });

    it('3b. COOPERATIVE viewer ↔ FARMER membre → FULL (manager relation)', async () => {
      // La coop a besoin du contact complet de ses membres pour les
      // gérer (avances, validation annonces, suivi ventes).
      prisma.shipments.findFirst.mockResolvedValue(null);
      prisma.commandes_vente.findFirst.mockResolvedValue(null);
      const coopA = 'coop-A';
      prisma.cooperative_members.findMany.mockResolvedValue([
        { cooperative_id: coopA, member_id: VIEWER },
        { cooperative_id: coopA, member_id: OBSERVED },
      ]);

      const v = await service.resolveVisibility(VIEWER, 'COOPERATIVE', OBSERVED);
      expect(v).toBe('FULL');
    });

    it('4. ADMIN → toujours FULL (sans même consulter la DB)', async () => {
      const v = await service.resolveVisibility(VIEWER, 'ADMIN', OBSERVED);
      expect(v).toBe('FULL');
      // Aucune requête DB : règle 2 (ADMIN) court-circuite tout.
      expect(prisma.shipments.findFirst).not.toHaveBeenCalled();
      expect(prisma.commandes_vente.findFirst).not.toHaveBeenCalled();
      expect(prisma.cooperative_members.findMany).not.toHaveBeenCalled();
    });

    it('self (viewer = observed) → FULL', async () => {
      const v = await service.resolveVisibility(VIEWER, 'BUYER', VIEWER);
      expect(v).toBe('FULL');
    });

    it('viewer anonyme → MIN', async () => {
      const v = await service.resolveVisibility(null, null, OBSERVED);
      expect(v).toBe('MIN');
    });

    it('BUYER avec commande ACCEPTED entre les 2 → PARTIAL', async () => {
      prisma.shipments.findFirst.mockResolvedValue(null);
      prisma.commandes_vente.findFirst.mockResolvedValue({ id: 'cmd-1' });

      const v = await service.resolveVisibility(VIEWER, 'BUYER', OBSERVED);
      expect(v).toBe('PARTIAL');
    });
  });

  // ===================================================================
  //  applyMaskValue — masque nom + téléphone en MIN
  // ===================================================================

  describe('5. applyMaskValue (MIN) : nom et téléphone masqués', () => {
    it('maskName tronque "Yao Kouassi" → "Yao K."', () => {
      expect(service.maskName('Yao Kouassi')).toBe('Yao K.');
    });

    it('maskName conserve un mono-mot ("Aïcha" → "Aïcha")', () => {
      expect(service.maskName('Aïcha')).toBe('Aïcha');
    });

    it('maskName sur null/empty → "Utilisateur"', () => {
      expect(service.maskName(null)).toBe('Utilisateur');
      expect(service.maskName('')).toBe('Utilisateur');
    });

    it('maskPhone garde indicatif + 2 derniers chiffres', () => {
      expect(service.maskPhone('+2250709123456')).toBe('+225 ** ** ** 56');
    });

    it('maskPhone sur null → placeholder safe', () => {
      expect(service.maskPhone(null)).toBe('+*** ** ** ** **');
    });

    it('maskPhoneFor en MIN → troncation (pas de proxy)', async () => {
      const masked = await service.maskPhoneFor(
        '+2250709123456',
        'MIN',
        'viewer',
        'observed',
      );
      expect(masked).toBe('+225 ** ** ** 56');
    });

    it('maskPhoneFor en FULL → numéro intact', async () => {
      const masked = await service.maskPhoneFor(
        '+2250709123456',
        'FULL',
        'viewer',
        'observed',
      );
      expect(masked).toBe('+2250709123456');
    });

    it('maskGeo arrondit lat/lng à 2 décimales (~1 km)', () => {
      const g = service.maskGeo({ lat: 5.345317, lng: -4.024429 });
      expect(g).toEqual({ lat: 5.35, lng: -4.02 });
    });
  });
});
