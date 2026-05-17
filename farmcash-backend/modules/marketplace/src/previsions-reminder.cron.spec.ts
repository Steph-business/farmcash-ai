// =====================================================================
//  UNIT : PrevisionsReminderCron (Chantier 5.b)
//  ---------------------------------------------------------------------
//  Couvre la méthode publique runOnce() — on n'exécute pas le setInterval
//  réel (on ne teste que le travail métier). Couvre :
//
//   1. Une prévision dont date_recolte_prev = now()+5j → 1 notif créée
//   2. Une prévision avec une notif PREVISION_J5_REMINDER < 6j déjà
//      en base → aucune nouvelle notif (anti-spam).
//
//  Tous les accès DB sont stubés. NotificationsService est injecté
//  mais le cron utilise prisma.notifications.create directement
//  (cf. note dans previsions-reminder.cron.ts).
// =====================================================================

import { PrevisionsReminderCron } from './previsions-reminder.cron';

function createPrismaStub() {
  return {
    previsions_production: {
      findMany: jest.fn(),
    },
    notifications: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };
}

function createConfigStub(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  };
}

/** NotificationsService stub — pas appelé par runOnce(), mais requis par DI. */
function createNotificationsStub() {
  return { create: jest.fn().mockResolvedValue({}) };
}

describe('PrevisionsReminderCron', () => {
  let cron: PrevisionsReminderCron;
  let prisma: ReturnType<typeof createPrismaStub>;
  let config: ReturnType<typeof createConfigStub>;
  let notifications: ReturnType<typeof createNotificationsStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    config = createConfigStub({ DISABLE_PREVISIONS_REMINDER: 'true' });
    notifications = createNotificationsStub();
    cron = new PrevisionsReminderCron(
      prisma as any,
      notifications as any,
      config as any,
    );
  });

  it('1. envoie 1 notif PREVISION_J5_REMINDER pour une prévision à J+5', async () => {
    const PREVISION_ID = 'prev-1';
    const FARMER_ID = 'farmer-1';
    // Prévision OPEN dont date_recolte_prev tombe dans la fenêtre [J+4, J+6]
    prisma.previsions_production.findMany.mockResolvedValue([
      {
        id: PREVISION_ID,
        farmer_id: FARMER_ID,
        date_recolte_prev: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        produits_agricoles: { nom: 'Cacao' },
      },
    ]);
    // Anti-spam : aucune notif récente
    prisma.notifications.findFirst.mockResolvedValue(null);
    prisma.notifications.create.mockResolvedValue({ id: 'notif-1' });

    const result = await cron.runOnce();

    expect(result.scanned).toBe(1);
    expect(result.notified).toBe(1);
    expect(prisma.notifications.create).toHaveBeenCalledTimes(1);
    expect(prisma.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: FARMER_ID,
          type: 'PREVISION_J5_REMINDER',
          titre: expect.stringContaining('Cacao'),
          data: expect.objectContaining({ prevision_id: PREVISION_ID }),
        }),
      }),
    );
  });

  it('2. anti-spam : skip si une notif PREVISION_J5_REMINDER existe pour cette prévision < 6j', async () => {
    const PREVISION_ID = 'prev-2';
    const FARMER_ID = 'farmer-2';
    prisma.previsions_production.findMany.mockResolvedValue([
      {
        id: PREVISION_ID,
        farmer_id: FARMER_ID,
        date_recolte_prev: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        produits_agricoles: { nom: 'Café' },
      },
    ]);
    // Une notif a déjà été envoyée il y a 2 jours
    prisma.notifications.findFirst.mockResolvedValue({
      id: 'notif-existing',
      type: 'PREVISION_J5_REMINDER',
      created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    const result = await cron.runOnce();

    expect(result.scanned).toBe(1);
    // Skippé → 0 notif créée
    expect(result.notified).toBe(0);
    expect(prisma.notifications.create).not.toHaveBeenCalled();
  });
});
