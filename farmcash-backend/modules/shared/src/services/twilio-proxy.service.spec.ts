// =====================================================================
//  UNIT : TwilioProxyService (Chantier 5.a)
//  ---------------------------------------------------------------------
//  Couvre :
//   1. getOrCreateProxyNumber retourne un numéro mock en dev
//      (pas de TWILIO_ACCOUNT_SID/TOKEN).
//   2. Idempotence : 2 appels avec la même paire (caller, callee, ctx)
//      → la session ACTIVE existante est réutilisée (1 seule allocation).
// =====================================================================

import { TwilioProxyService } from './twilio-proxy.service';

function createPrismaStub() {
  return {
    phone_proxy_sessions: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

function createConfigStub(overrides: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  };
}

describe('TwilioProxyService', () => {
  let service: TwilioProxyService;
  let prisma: ReturnType<typeof createPrismaStub>;
  let config: ReturnType<typeof createConfigStub>;

  const CALLER = 'caller-uuid';
  const CALLEE = 'callee-uuid';

  beforeEach(() => {
    prisma = createPrismaStub();
    // En dev par défaut : pas de TWILIO_ACCOUNT_SID/TOKEN → mode mock.
    config = createConfigStub({});
    service = new TwilioProxyService(prisma as any, config as any);
  });

  it('1. retourne un numéro mock en dev (pas de credentials Twilio)', async () => {
    // Aucune session existante
    prisma.phone_proxy_sessions.findFirst.mockResolvedValue(null);
    // Le create renvoie ce que TwilioProxyService allocate via mock
    prisma.phone_proxy_sessions.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: 'session-1',
        proxy_phone: data.proxy_phone,
        expires_at: data.expires_at,
      }),
    );

    const session = await service.getOrCreateProxyNumber(CALLER, CALLEE);

    expect(session).not.toBeNull();
    // Format mock : numéro CI commençant par +225 (ou base configurée), 11 chiffres total
    expect(session!.proxyPhone).toMatch(/^\+225\d{8}$/);
    expect(session!.sessionId).toBe('session-1');
    // Insert appelé exactement 1 fois
    expect(prisma.phone_proxy_sessions.create).toHaveBeenCalledTimes(1);
  });

  it('2. idempotent : 2 appels avec la même paire (caller, callee) → même session', async () => {
    const existing = {
      id: 'existing-session',
      proxy_phone: '+22550123456',
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    };
    // Les 2 appels trouvent la même session active → pas de re-création.
    prisma.phone_proxy_sessions.findFirst.mockResolvedValue(existing);

    const first = await service.getOrCreateProxyNumber(CALLER, CALLEE);
    const second = await service.getOrCreateProxyNumber(CALLER, CALLEE);

    expect(first?.sessionId).toBe('existing-session');
    expect(second?.sessionId).toBe('existing-session');
    expect(first?.proxyPhone).toBe(second?.proxyPhone);
    // Aucun create : on a réutilisé la session existante.
    expect(prisma.phone_proxy_sessions.create).not.toHaveBeenCalled();
  });
});
