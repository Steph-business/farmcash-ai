// =====================================================================
//  E2E : Module Messaging
//  ---------------------------------------------------------------------
//  Couvre :
//   • Création de conversation DIRECT (idempotent : 2 fois = même conv)
//   • Envoi de message → vérifie persistance
//   • Listage des conversations + des messages
//   • Garde-fou : un tiers ne peut PAS envoyer dans une conversation
//   • Validation DTO : message vide, media_type invalide, URL invalide
// =====================================================================

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  bearer,
  cleanupTestUsers,
  createTestApp,
  registerAndGetToken,
} from './setup';

describe('Messaging (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await cleanupTestUsers(app);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  describe('Conversations DIRECT', () => {
    it('crée une conversation entre 2 users + dedupe sur 2e appel', async () => {
      const alice = await registerAndGetToken(app, {
        full_name: 'Alice Msg',
        role: 'BUYER',
      });
      const bob = await registerAndGetToken(app, {
        full_name: 'Bob Msg',
        role: 'FARMER',
      });

      const res1 = await request(app.getHttpServer())
        .post('/api/messaging/conversations')
        .set(bearer(alice.token))
        .send({ participants: [bob.userId] })
        .expect(200);

      const convId = res1.body.data.id;
      expect(convId).toBeDefined();
      expect(res1.body.data.conversation_participants).toHaveLength(2);

      // Recréer la même conversation depuis l'autre côté → même id
      const res2 = await request(app.getHttpServer())
        .post('/api/messaging/conversations')
        .set(bearer(bob.token))
        .send({ participants: [alice.userId] })
        .expect(200);
      expect(res2.body.data.id).toBe(convId);
    });

    it('flow message complet : send + list + read', async () => {
      const alice = await registerAndGetToken(app, {
        full_name: 'Alice Flow',
        role: 'BUYER',
      });
      const bob = await registerAndGetToken(app, {
        full_name: 'Bob Flow',
        role: 'FARMER',
      });

      const conv = await request(app.getHttpServer())
        .post('/api/messaging/conversations')
        .set(bearer(alice.token))
        .send({ participants: [bob.userId] })
        .expect(200);
      const convId = conv.body.data.id;

      // Alice envoie 2 messages
      await request(app.getHttpServer())
        .post(`/api/messaging/conversations/${convId}/messages`)
        .set(bearer(alice.token))
        .send({ content: 'Bonjour Bob !' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/messaging/conversations/${convId}/messages`)
        .set(bearer(alice.token))
        .send({ content: 'Tu as du cacao ?' })
        .expect(201);

      // Bob liste les messages
      const list = await request(app.getHttpServer())
        .get(`/api/messaging/conversations/${convId}/messages`)
        .set(bearer(bob.token))
        .expect(200);
      expect(list.body.data.data).toHaveLength(2);
      expect(list.body.data.meta.total).toBe(2);

      // Bob marque comme lue
      await request(app.getHttpServer())
        .put(`/api/messaging/conversations/${convId}/read`)
        .set(bearer(bob.token))
        .expect(200);
    });
  });

  describe('Sécurité : 403 sur conversation tierce', () => {
    it("refuse à un tiers d'envoyer dans une conversation où il n'est pas", async () => {
      const alice = await registerAndGetToken(app, {
        full_name: 'Alice Sec',
        role: 'BUYER',
      });
      const bob = await registerAndGetToken(app, {
        full_name: 'Bob Sec',
        role: 'FARMER',
      });
      const intruder = await registerAndGetToken(app, {
        full_name: 'Intruder Sec',
        role: 'BUYER',
      });

      const conv = await request(app.getHttpServer())
        .post('/api/messaging/conversations')
        .set(bearer(alice.token))
        .send({ participants: [bob.userId] })
        .expect(200);

      // L'intruder essaie d'envoyer un message → 403
      await request(app.getHttpServer())
        .post(`/api/messaging/conversations/${conv.body.data.id}/messages`)
        .set(bearer(intruder.token))
        .send({ content: 'Hack' })
        .expect(403);

      // Et de lire les messages → 403
      await request(app.getHttpServer())
        .get(`/api/messaging/conversations/${conv.body.data.id}/messages`)
        .set(bearer(intruder.token))
        .expect(403);
    });
  });

  describe('Validation DTOs', () => {
    let token: string;

    beforeAll(async () => {
      const u = await registerAndGetToken(app, {
        full_name: 'Validation User',
        role: 'BUYER',
      });
      token = u.token;
    });

    it('refuse content vide', async () => {
      await request(app.getHttpServer())
        .post('/api/messaging/conversations/00000000-0000-0000-0000-000000000000/messages')
        .set(bearer(token))
        .send({ content: '' })
        .expect(400);
    });

    it('refuse media_type non-enum', async () => {
      await request(app.getHttpServer())
        .post('/api/messaging/conversations/00000000-0000-0000-0000-000000000000/messages')
        .set(bearer(token))
        .send({ content: 'test', media_type: 'INVALID_TYPE' })
        .expect(400);
    });

    it('refuse media_url non-URL', async () => {
      await request(app.getHttpServer())
        .post('/api/messaging/conversations/00000000-0000-0000-0000-000000000000/messages')
        .set(bearer(token))
        .send({ content: 'test', media_url: 'pas une url' })
        .expect(400);
    });
  });
});
