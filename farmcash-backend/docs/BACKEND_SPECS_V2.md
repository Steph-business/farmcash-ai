# Backend FarmCash — Specs V2

> Roadmap technique pour supporter le flow complet mobile (4 rôles : COOPERATIVE, FARMER, BUYER, TRANSPORTER).
> Auteur : Steph — date : 2026-05-17.
> Audit basé sur 90 maquettes mobiles (Coop 28 + Producteur 24 + Acheteur 22 + Transporteur 16).

---

## Table des matières

- [0. État des lieux](#0-état-des-lieux)
- [1. Chantier — Scan QR enlèvement + auto-release escrow producteur](#1-chantier--scan-qr-enlèvement--auto-release-escrow-producteur)
- [2. Chantier — Sollicitations coop multi-audience](#2-chantier--sollicitations-coop-multi-audience)
- [3. Chantier — Data masking (anti-contournement) selon rôle](#3-chantier--data-masking-anti-contournement-selon-rôle)
- [4. Chantier — Wallet recharger multi-méthodes](#4-chantier--wallet-recharger-multi-méthodes)
- [5. Chantier (low prio) — Téléphone proxy + notif prévision J-5](#5-chantier-low-prio--téléphone-proxy--notif-prévision-j-5)
- [Roadmap d'implémentation (Gantt simplifié)](#roadmap-dimplémentation-gantt-simplifié)
- [Annexe A — Conventions FarmCash](#annexe-a--conventions-farmcash)
- [Annexe B — Glossaire](#annexe-b--glossaire)

---

## 0. État des lieux

Audit du backend NestJS effectué le 2026-05-17, croisé avec les 90 maquettes mobiles. Synthèse :

- **Existe déjà (à réutiliser tel quel)** : tarification livraison (`transporter_routes` + `POST /logistics/routes` + `GET /logistics/quotes`), matching transporteurs (`GET /logistics/missions/available`), propositions producteur ↔ acheteur (table `propositions_vente` + module `negotiation`), QR traçabilité publique (`GET /ai/traceability/:lotId`), framework paiement multi-méthodes (enums OM/MTN/Moov/Wave + table `moyen_de_payement`), conversion prévision → annonce (`POST /marketplace/previsions/:id/convert`), release escrow à la livraison (`POST /finance/confirm-delivery`).
- **Existe partiellement (à étendre)** : QR scan enlèvement/livraison (méthodes `startLoading()` / `markDelivered()` présentes mais sans validation cryptographique) ; escrow (release manuel à la livraison OK mais pas d'auto-release à l'enlèvement) ; notifs prévision J-5 (pas de cron de rappel) ; wallet (retrait OK via `processPayout` mais pas d'endpoint de recharge).
- **Manque totalement (à créer)** : data masking selon rôle (anti-contournement style Uber), téléphone proxy (TwilioProxy), sollicitations coop multi-audience (membres / coops voisines / indépendants).

Les 5 chantiers décrits ci-dessous comblent ces gaps. Chaque chantier est autonome — un développeur peut prendre n'importe lequel sans dépendre du précédent (sauf indication explicite).

---

## 1. Chantier — Scan QR enlèvement + auto-release escrow producteur

### Contexte produit

Maquettes concernées : `Transporteur/scan_enlevement.png`, `Producteur/confirmation_enlevement.png`, `Producteur/wallet_release.png`.

Aujourd'hui, le transporteur tape un bouton "J'ai chargé" qui passe le shipment en `LOADING` sans aucune preuve cryptographique. L'escrow PRODUCT (= argent producteur) n'est libéré qu'à la livraison finale, ce qui pénalise le producteur qui doit attendre 24-72h après l'enlèvement.

Objectif : remplacer le bouton par un **scan QR** côté transporteur. Le QR est généré sur le téléphone du producteur (signé serveur, durée 15 min, unique par shipment). Au scan valide :

1. Le shipment passe en `LOADING`.
2. L'escrow PRODUCT du producteur est **auto-libéré** (`PRODUCT` uniquement, pas `TRANSPORT`).
3. Le producteur reçoit une notif "Argent crédité".
4. Une entrée `traceability_events` `PICKUP_QR_SCANNED` est créée (audit).

Bénéfices : (a) preuve fraude-resistante (impossible de prétendre "j'ai chargé" sans présence physique), (b) trésorerie producteur libérée immédiatement (game-changer petit producteur), (c) traçabilité renforcée pour les commandes export.

### Migration DB (SQL)

```sql
-- Migration 20260518_qr_pickup_signed.sql

-- 1. Token signé attaché au shipment.
--    Format : <shipment_id_short>.<exp_unix>.<hmac_sha256_16chars>
--    Régénéré à chaque appel /qr-token (expire dans 15 min).
ALTER TABLE shipments
  ADD COLUMN pickup_qr_token        VARCHAR(120),
  ADD COLUMN pickup_qr_expires_at   TIMESTAMPTZ,
  ADD COLUMN pickup_scanned_at      TIMESTAMPTZ,
  ADD COLUMN pickup_scanned_by      UUID REFERENCES users(id);

-- 2. Index pour retrouver rapidement le token au scan
CREATE INDEX idx_shipments_pickup_token ON shipments(pickup_qr_token)
  WHERE pickup_qr_token IS NOT NULL;

-- 3. Compteur d'auto-release pour éviter double-release
--    (au cas où le scan serait rejoué : on doit garantir idempotence).
ALTER TABLE escrow_conditions
  ADD COLUMN auto_released_on_pickup BOOLEAN DEFAULT FALSE;

-- 4. Nouveau type d'event traceability dédié
--    (event_type est libre VARCHAR, pas d'enum SQL à modifier).
COMMENT ON COLUMN traceability_events.event_type IS
  'CREATED | UPDATED | VALIDATED | PICKUP_QR_SCANNED | DELIVERED | ...';
```

> NOTE : si la migration crée déjà des shipments existants en base avec `pickup_qr_token = NULL`, c'est OK — le token n'est généré qu'à la demande explicite via l'endpoint `/qr-token`.

### Modifications schema.prisma (extrait)

```prisma
model shipments {
  // ... champs existants
  pickup_qr_token         String?   @db.VarChar(120)
  pickup_qr_expires_at    DateTime? @db.Timestamptz(6)
  pickup_scanned_at       DateTime? @db.Timestamptz(6)
  pickup_scanned_by       String?   @db.Uuid
  users_pickup_scanner    users?    @relation("shipments_pickup_scannerTousers", fields: [pickup_scanned_by], references: [id], onUpdate: NoAction)

  @@index([pickup_qr_token], map: "idx_shipments_pickup_token")
}

model escrow_conditions {
  // ... champs existants
  auto_released_on_pickup Boolean   @default(false)
}

model users {
  // ... ajouter la relation inverse
  shipments_pickup_scanned shipments[] @relation("shipments_pickup_scannerTousers")
}
```

### DTOs (TypeScript prêts à coller)

Fichier cible : `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/logistics/src/dto/shipments.dto.ts` (ajouter en fin de fichier).

```typescript
/**
 * Réponse de GET /shipments/:id/qr-token (producteur uniquement).
 * Le client mobile encode `token` dans un QR code (formato PNG/SVG côté UI).
 */
export class PickupQrTokenResponseDto {
  @ApiProperty({ example: 'a1b2c3d4.1737062400.f9e8d7c6b5a4' })
  token: string;

  @ApiProperty({ example: '2026-05-18T14:30:00Z' })
  expires_at: string;

  @ApiProperty({ example: 900 })
  ttl_seconds: number;
}

/**
 * Body de POST /shipments/:id/scan-pickup (transporteur uniquement).
 * Le token vient du QR scanné chez le producteur.
 */
export class ScanPickupDto {
  @ApiProperty({ description: 'Token brut lu depuis le QR' })
  @IsString()
  @IsNotEmpty()
  @Length(20, 120)
  token: string;

  /**
   * Position GPS au moment du scan (anti-fraude : on vérifie que le
   * transporteur est physiquement à < 500 m du pickup_location).
   */
  @ApiProperty({ type: GpsPointDto })
  @ValidateNested()
  @Type(() => GpsPointDto)
  scan_position: GpsPointDto;
}
```

### Endpoints REST

```
GET /api/logistics/shipments/:id/qr-token
Auth: Bearer JWT
Roles: FARMER (seller_id de la commande liée)
Response 200: PickupQrTokenResponseDto
Errors:
  - 403 si user.sub !== commande.seller_id
  - 404 si shipment introuvable
  - 409 si shipment.status !== ACCEPTED (le QR n'a de sens qu'entre
        l'acceptation et le chargement)
```

```
POST /api/logistics/shipments/:id/scan-pickup
Auth: Bearer JWT
Roles: TRANSPORTER (transporter_id du shipment)
Body: ScanPickupDto
Response 200: { shipment, escrow_released: { product: { amount, beneficiary_id } } }
Errors:
  - 400 si token signature invalide
  - 400 si token expiré (> 15 min)
  - 400 si scan_position > 500 m du pickup_location
  - 403 si shipment.transporter_id !== user.sub
  - 409 si shipment.status !== ACCEPTED ou si pickup_scanned_at !== null (idempotence)
```

### Logique service (pseudo-code commenté)

Fichier cible : `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/logistics/src/logistics.service.ts`.

```typescript
// =====================================================================
//  QR PICKUP TOKEN — génération côté producteur
// =====================================================================

async generatePickupQrToken(userId: string, shipmentId: string) {
  // 1. Charger shipment + commande pour vérifier ownership
  const shipment = await this.prisma.shipments.findUnique({
    where: { id: shipmentId },
    include: { commandes_vente: true },
  });
  if (!shipment) throw new NotFoundException('Shipment introuvable.');

  // 2. Seul le seller (producteur) du shipment peut générer le QR
  if (shipment.commandes_vente.seller_id !== userId) {
    throw new ForbiddenException('Vous n\'êtes pas le vendeur de cette commande.');
  }

  // 3. Le QR n'a de sens qu'entre ACCEPTED et LOADING
  if (shipment.status !== 'ACCEPTED') {
    throw new ConflictException(
      `Le QR ne peut être généré qu'au statut ACCEPTED (actuel: ${shipment.status}).`,
    );
  }

  // 4. Composer la payload + signer HMAC-SHA256
  //    Format : <shipId_8chars>.<exp_unix>.<sig_16chars>
  const TTL_SEC = 15 * 60;
  const expUnix = Math.floor(Date.now() / 1000) + TTL_SEC;
  const shipShort = shipmentId.replace(/-/g, '').slice(0, 8);
  const payload = `${shipShort}.${expUnix}`;
  const secret = this.config.get<string>('QR_PICKUP_SECRET');
  if (!secret || secret.length < 32) {
    throw new InternalServerErrorException('QR_PICKUP_SECRET non configuré.');
  }
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  const token = `${payload}.${sig}`;
  const expiresAt = new Date(expUnix * 1000);

  // 5. Persister pour la vérif côté scan (et invalider l'ancien token)
  await this.prisma.shipments.update({
    where: { id: shipmentId },
    data: { pickup_qr_token: token, pickup_qr_expires_at: expiresAt },
  });

  return { token, expires_at: expiresAt.toISOString(), ttl_seconds: TTL_SEC };
}

// =====================================================================
//  SCAN PICKUP — transporteur scanne, on libère l'escrow PRODUCT
// =====================================================================

async scanPickup(transporterId: string, shipmentId: string, dto: ScanPickupDto) {
  // 1. Vérification cryptographique du token AVANT toute écriture DB
  //    (rejette les forgeries sans coûter une lecture).
  const parts = dto.token.split('.');
  if (parts.length !== 3) throw new BadRequestException('Token mal formé.');
  const [shipShort, expUnixStr, sig] = parts;
  const secret = this.config.get<string>('QR_PICKUP_SECRET')!;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${shipShort}.${expUnixStr}`)
    .digest('hex')
    .slice(0, 16);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    throw new BadRequestException('Signature QR invalide.');
  }
  const expUnix = parseInt(expUnixStr, 10);
  if (Number.isNaN(expUnix) || expUnix * 1000 < Date.now()) {
    throw new BadRequestException('QR expiré. Demandez au producteur de regénérer.');
  }

  // 2. Charger shipment + commande, vérifier ownership
  const shipment = await this.prisma.shipments.findUnique({
    where: { id: shipmentId },
    include: { commandes_vente: true },
  });
  if (!shipment) throw new NotFoundException('Shipment introuvable.');
  if (shipment.transporter_id !== transporterId) {
    throw new ForbiddenException('Mission non rattachée à votre compte.');
  }
  if (shipment.pickup_qr_token !== dto.token) {
    throw new BadRequestException('Ce QR a déjà été remplacé (regénérez).');
  }

  // 3. Idempotence : si déjà scanné, retourner l'état actuel
  if (shipment.pickup_scanned_at) {
    return { shipment, escrow_released: { product: { already_done: true } } };
  }

  // 4. Anti-fraude GPS : transporteur doit être à < 500 m du pickup
  if (shipment.pickup_location) {
    const distMeters = await this.prisma.$queryRaw<{ d: number }[]>`
      SELECT ST_Distance(
        ${shipment.pickup_location}::geography,
        ST_SetSRID(ST_MakePoint(${dto.scan_position.lng}, ${dto.scan_position.lat}), 4326)::geography
      ) AS d`;
    if (distMeters[0]?.d > 500) {
      throw new BadRequestException(
        `Vous êtes à ${Math.round(distMeters[0].d)} m du point de retrait (max: 500 m).`,
      );
    }
  }

  // 5. Atomique : bascule shipment + libération escrow PRODUCT + traceability
  const result = await this.prisma.$transaction(async (tx) => {
    // a) Marquer scanné + bascule LOADING (= état semantic "en cours de chargement")
    const updated = await tx.shipments.update({
      where: { id: shipmentId },
      data: {
        status: 'LOADING',
        pickup_scanned_at: new Date(),
        pickup_scanned_by: transporterId,
        // On laisse pickup_qr_token tel quel pour l'audit
      },
    });

    // b) Insérer tracking point GPS
    await tx.$executeRaw`
      INSERT INTO shipment_tracking (shipment_id, location, status, note)
      VALUES (
        ${shipmentId}::uuid,
        ST_SetSRID(ST_MakePoint(${dto.scan_position.lng}, ${dto.scan_position.lat}), 4326),
        'LOADING'::shipment_status,
        'QR scan pickup'
      );
    `;

    // c) Traceability event (si la commande est liée à un lot)
    if (shipment.commandes_vente.lot_id) {
      await tx.$executeRaw`
        INSERT INTO traceability_events (lot_id, event_type, actor_id, location, metadata)
        VALUES (
          ${shipment.commandes_vente.lot_id}::uuid,
          'PICKUP_QR_SCANNED',
          ${transporterId}::uuid,
          ST_SetSRID(ST_MakePoint(${dto.scan_position.lng}, ${dto.scan_position.lat}), 4326),
          ${JSON.stringify({ shipment_id: shipmentId })}::jsonb
        );
      `;
    }

    return updated;
  });

  // 6. Hors transaction : libérer l'escrow PRODUCT via FinanceService
  //    (réutilise releaseEscrow existant avec kindFilter=PRODUCT)
  //    NB : pas d'await blocking dans la TX car releaseEscrow ouvre sa propre TX.
  let releasePayload;
  try {
    releasePayload = await this.finance.releaseEscrow(
      shipment.commande_id,
      transporterId,
      EscrowKind.PRODUCT,
      'AUTO_PICKUP_SCAN',
    );
    // Marquer le flag auto_released_on_pickup pour distinguer dans le reporting
    await this.prisma.escrow_conditions.updateMany({
      where: {
        commande_id: shipment.commande_id,
        kind: 'PRODUCT',
        released_by: transporterId,
        release_reason: 'AUTO_PICKUP_SCAN',
      },
      data: { auto_released_on_pickup: true },
    });
  } catch (e) {
    // Si la release échoue (ex: déjà libérée), on log mais on ne casse pas
    // le scan : le shipment est légitimement en LOADING.
    this.logger.warn(`Release PRODUCT échoué après scan ${shipmentId}: ${e?.message}`);
  }

  // 7. Notifier le producteur (notif + SSE)
  await this.notifications.create({
    user_id: shipment.commandes_vente.seller_id,
    type: 'PAYMENT_RELEASED',
    titre: 'Marchandise enlevée — argent disponible',
    body: 'Le transporteur a confirmé l\'enlèvement. Votre paiement est crédité.',
    shipment_id: shipmentId,
    commande_id: shipment.commande_id,
  });

  return { shipment: result, escrow_released: releasePayload };
}
```

> NOTE technique : `releaseEscrow` existant (cf. `finance.service.ts:483`) accepte déjà un `kindFilter` et est idempotent (skip si plus de LOCKED). Aucune modification du service finance n'est requise — on se contente d'appeler avec `EscrowKind.PRODUCT`.

### Tests à prévoir

**Unitaires** (`logistics.service.spec.ts`) :

1. `generatePickupQrToken` retourne un token bien formé + persiste expiry.
2. `generatePickupQrToken` refuse si user n'est pas le seller (403).
3. `generatePickupQrToken` refuse si shipment !== ACCEPTED (409).
4. `scanPickup` rejette token avec signature forgée (400).
5. `scanPickup` rejette token expiré (400).
6. `scanPickup` idempotent : un second scan retourne `already_done: true` sans nouvelle release.
7. `scanPickup` rejette GPS > 500 m (400).
8. `scanPickup` libère uniquement PRODUCT (pas TRANSPORT) — vérifier `escrow_conditions` après.

**E2E** (`logistics.e2e-spec.ts`) :

1. Cycle complet : FARMER génère QR → TRANSPORTER scan → balance escrow producteur passe en balance dispo.
2. Tentative scan avec JWT BUYER → 403.
3. Tentative scan deux fois en parallèle (race condition) : une seule libération en base.

**Cas critiques** :

- Si `QR_PICKUP_SECRET` n'est pas configuré : refus au boot (cf. validation `auth.module`).
- Si la commande n'a pas de `lot_id` : pas d'insert `traceability_events` mais le reste passe.
- Si l'escrow PRODUCT a déjà été libéré manuellement par un admin : la release lève une 404 silencieuse, on n'échoue pas le scan.

### Effort estimé

- DB migration : 1 h
- Backend (service + controller + DTOs) : 2 j
- Tests unitaires + e2e : 1 j
- **Total : 3.5 j**

---

## 2. Chantier — Sollicitations coop multi-audience

### Contexte produit

Maquettes concernées : `Coop/sollicitations_nouvelle.png` (4 onglets : membres / coops voisines / indépendants / récapitulatif), `Coop/sollicitations_liste.png`, `Producteur/invitations_recues.png`.

Quand une coopérative reçoit une offre d'achat ciblée (`annonces_achat` avec `target_audience = SPECIFIC_COOPERATIVE` ou `ALL_COOPERATIVES`), son président doit pouvoir **mobiliser des producteurs** pour atteindre le tonnage demandé. Aujourd'hui il n'y a aucun mécanisme : la coop voit la demande mais ne peut pas la diffuser.

Une sollicitation est un objet métier qui agrège :

- la demande source (`annonce_achat_id`),
- une ou plusieurs audiences cibles : `MEMBRES` (membres actifs de la coop) / `COOPS_VOISINES` (coops du même `region_id` ou rayon X km) / `INDEPENDANTS` (FARMER sans coop dans le rayon),
- un message libre,
- un suivi des réponses (1 ligne par destinataire dans `sollicitation_responses`).

À la création, le backend fan-out les notifs + un message SMS court vers chaque cible, et persiste les destinataires pour suivre les ouvertures/réponses.

### Migration DB (SQL)

```sql
-- Migration 20260519_sollicitations_coop.sql

-- 1. Table principale
CREATE TABLE sollicitations_coop (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id        UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  annonce_achat_id      UUID NOT NULL REFERENCES annonces_achat(id) ON DELETE CASCADE,
  initiated_by          UUID NOT NULL REFERENCES users(id),
  message               TEXT NOT NULL,
  audiences             TEXT[] NOT NULL,        -- ex: ['MEMBRES','INDEPENDANTS']
  rayon_km              INT DEFAULT 50,         -- pour COOPS_VOISINES + INDEPENDANTS
  quantite_cible_kg     DECIMAL(12,2),          -- copie de annonces_achat.quantite_kg
  expires_at            TIMESTAMPTZ NOT NULL,   -- défaut: created_at + 7j
  status                VARCHAR(20) NOT NULL DEFAULT 'OPEN',  -- OPEN / CLOSED / FULFILLED
  total_recipients      INT DEFAULT 0,
  total_responses       INT DEFAULT 0,
  total_quantite_offerte DECIMAL(12,2) DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sollicit_coop ON sollicitations_coop(cooperative_id);
CREATE INDEX idx_sollicit_annonce ON sollicitations_coop(annonce_achat_id);
CREATE INDEX idx_sollicit_status ON sollicitations_coop(status);

-- 2. Destinataires individuels (fan-out)
--    Une ligne par (sollicitation × user) pour pouvoir tracer les réponses.
CREATE TABLE sollicitation_recipients (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sollicitation_id      UUID NOT NULL REFERENCES sollicitations_coop(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id),
  audience_segment      VARCHAR(20) NOT NULL,  -- MEMBRES / COOPS_VOISINES / INDEPENDANTS
  cooperative_id        UUID REFERENCES cooperative_profiles(id),  -- NULL pour INDEPENDANTS
  notification_id       UUID REFERENCES notifications(id),
  sms_sent_at           TIMESTAMPTZ,
  opened_at             TIMESTAMPTZ,
  responded_at          TIMESTAMPTZ,
  response_action       VARCHAR(20),           -- ACCEPTED / REJECTED / IGNORED
  response_quantite_kg  DECIMAL(10,2),         -- quantité que le destinataire s'engage à fournir
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sollicitation_id, user_id)
);

CREATE INDEX idx_sollicit_recipients_user ON sollicitation_recipients(user_id);
CREATE INDEX idx_sollicit_recipients_segment ON sollicitation_recipients(audience_segment);
```

### Modifications schema.prisma (extrait)

```prisma
model sollicitations_coop {
  id                       String                       @id @default(dbgenerated("uuid_generate_v4()")) @db.Uuid
  cooperative_id           String                       @db.Uuid
  annonce_achat_id         String                       @db.Uuid
  initiated_by             String                       @db.Uuid
  message                  String
  audiences                String[]
  rayon_km                 Int?                         @default(50)
  quantite_cible_kg        Decimal?                     @db.Decimal(12, 2)
  expires_at               DateTime                     @db.Timestamptz(6)
  status                   String                       @default("OPEN") @db.VarChar(20)
  total_recipients         Int                          @default(0)
  total_responses          Int                          @default(0)
  total_quantite_offerte   Decimal                      @default(0) @db.Decimal(12, 2)
  created_at               DateTime                     @default(now()) @db.Timestamptz(6)
  updated_at               DateTime                     @default(now()) @db.Timestamptz(6)
  cooperative_profiles     cooperative_profiles         @relation(fields: [cooperative_id], references: [id], onDelete: Cascade)
  annonces_achat           annonces_achat               @relation(fields: [annonce_achat_id], references: [id], onDelete: Cascade)
  users                    users                        @relation(fields: [initiated_by], references: [id])
  sollicitation_recipients sollicitation_recipients[]

  @@index([cooperative_id], map: "idx_sollicit_coop")
  @@index([annonce_achat_id], map: "idx_sollicit_annonce")
  @@index([status], map: "idx_sollicit_status")
}

model sollicitation_recipients {
  id                   String              @id @default(dbgenerated("uuid_generate_v4()")) @db.Uuid
  sollicitation_id     String              @db.Uuid
  user_id              String              @db.Uuid
  audience_segment     String              @db.VarChar(20)
  cooperative_id       String?             @db.Uuid
  notification_id      String?             @db.Uuid
  sms_sent_at          DateTime?           @db.Timestamptz(6)
  opened_at            DateTime?           @db.Timestamptz(6)
  responded_at         DateTime?           @db.Timestamptz(6)
  response_action      String?             @db.VarChar(20)
  response_quantite_kg Decimal?            @db.Decimal(10, 2)
  created_at           DateTime            @default(now()) @db.Timestamptz(6)
  sollicitations_coop  sollicitations_coop @relation(fields: [sollicitation_id], references: [id], onDelete: Cascade)
  users                users               @relation(fields: [user_id], references: [id])

  @@unique([sollicitation_id, user_id])
  @@index([user_id], map: "idx_sollicit_recipients_user")
  @@index([audience_segment], map: "idx_sollicit_recipients_segment")
}
```

> Penser à ajouter `sollicitations_coop` + `sollicitation_recipients` aux relations inverses dans `users`, `cooperative_profiles`, `annonces_achat`.

### DTOs (TypeScript prêts à coller)

Nouveau fichier : `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/cooperatives/src/dto/sollicitations.dto.ts`.

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export enum SollicitationAudience {
  MEMBRES = 'MEMBRES',
  COOPS_VOISINES = 'COOPS_VOISINES',
  INDEPENDANTS = 'INDEPENDANTS',
}

export class CreateSollicitationDto {
  /** Demande d'achat source — doit cibler la coop (ou être ALL_COOPERATIVES). */
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  annonce_achat_id: string;

  @ApiProperty({ example: 'Besoin urgent de 5 tonnes de maïs cette semaine.' })
  @IsString()
  @Length(10, 2000)
  message: string;

  @ApiProperty({
    enum: SollicitationAudience,
    isArray: true,
    description: 'Au moins une audience requise',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(SollicitationAudience, { each: true })
  audiences: SollicitationAudience[];

  @ApiPropertyOptional({ default: 50, description: 'Rayon km pour COOPS_VOISINES + INDEPENDANTS' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  rayon_km?: number = 50;

  @ApiPropertyOptional({ description: 'Délai max en jours (défaut : 7)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  duree_jours?: number = 7;
}

/**
 * Body de POST /sollicitations/:id/respond (destinataire FARMER ou COOP).
 */
export class RespondSollicitationDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  @IsIn(['ACCEPTED', 'REJECTED'])
  action: 'ACCEPTED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Quantité offerte si ACCEPTED' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_kg?: number;
}

export class ListerSollicitationsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED', 'FULFILLED'] })
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED', 'FULFILLED'])
  status?: string;
}
```

### Endpoints REST

```
POST /api/coop/sollicitations
Auth: Bearer JWT
Roles: COOPERATIVE (le user doit être le user_id d'une cooperative_profiles)
Body: CreateSollicitationDto
Response 201: {
  sollicitation_id,
  recipients_count: { MEMBRES: number, COOPS_VOISINES: number, INDEPENDANTS: number },
  notifications_dispatched: number,
}
Errors:
  - 400 si annonce_achat.target_audience === 'PUBLIC' (pas de cible coop)
  - 403 si annonce_achat ne cible pas cette coop
  - 404 si annonce introuvable
  - 409 si annonce.is_active === false
```

```
GET /api/coop/sollicitations
Auth: Bearer JWT
Roles: COOPERATIVE
Query: ListerSollicitationsQueryDto
Response 200: { data: Sollicitation[], meta: pagination }
```

```
GET /api/coop/sollicitations/:id
Auth: Bearer JWT
Roles: COOPERATIVE (ownership) ou destinataire (sollicitation_recipients.user_id)
Response 200: { sollicitation, recipients: [], responses_summary }
```

```
POST /api/coop/sollicitations/:id/respond
Auth: Bearer JWT
Roles: FARMER (en tant que destinataire INDEPENDANT ou MEMBRE)
        ou COOPERATIVE (en tant que destinataire COOPS_VOISINES)
Body: RespondSollicitationDto
Response 200: { recipient_id, response_action, response_quantite_kg }
Errors:
  - 403 si user n'est pas dans sollicitation_recipients
  - 409 si déjà répondu (responded_at !== null)
  - 410 si sollicitation expirée
```

```
POST /api/coop/sollicitations/:id/close
Auth: Bearer JWT
Roles: COOPERATIVE (ownership)
Response 200: { status: 'CLOSED' }
```

### Logique service (pseudo-code commenté)

Fichier cible : nouveau fichier `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/cooperatives/src/sollicitations.service.ts` (ou ajout au `cooperatives.service.ts` existant si on veut limiter le nombre de fichiers — décision team).

```typescript
async createSollicitation(userId: string, dto: CreateSollicitationDto) {
  // 1. Identifier la coopérative de ce user (le user est le président)
  const coop = await this.prisma.cooperative_profiles.findUnique({
    where: { user_id: userId },
  });
  if (!coop) throw new ForbiddenException('Seul un compte COOPERATIVE peut solliciter.');

  // 2. Charger l'annonce source + vérifier qu'elle cible bien cette coop
  const annonce = await this.prisma.annonces_achat.findUnique({
    where: { id: dto.annonce_achat_id },
  });
  if (!annonce) throw new NotFoundException('Annonce d\'achat introuvable.');
  if (!annonce.is_active) {
    throw new ConflictException('Annonce inactive — impossible de solliciter.');
  }
  if (annonce.target_audience === 'PUBLIC') {
    throw new BadRequestException('Cette annonce est publique, pas de sollicitation utile.');
  }
  if (
    annonce.target_audience === 'SPECIFIC_COOPERATIVE' &&
    annonce.target_cooperative_id !== coop.id
  ) {
    throw new ForbiddenException('Annonce non ciblée sur votre coopérative.');
  }

  // 3. Résoudre les destinataires en fonction des audiences cochées
  const recipients: Array<{
    user_id: string;
    audience_segment: string;
    cooperative_id?: string;
  }> = [];

  // 3.a MEMBRES de la coop (actifs uniquement)
  if (dto.audiences.includes('MEMBRES')) {
    const members = await this.prisma.cooperative_members.findMany({
      where: { cooperative_id: coop.id, is_active: true },
      select: { member_id: true },
    });
    for (const m of members) {
      recipients.push({
        user_id: m.member_id,
        audience_segment: 'MEMBRES',
        cooperative_id: coop.id,
      });
    }
  }

  // 3.b COOPS VOISINES (autres coops dans le rayon_km)
  if (dto.audiences.includes('COOPS_VOISINES')) {
    const rayonMeters = (dto.rayon_km ?? 50) * 1000;
    const voisines = await this.prisma.$queryRaw<
      { user_id: string; coop_id: string }[]
    >`
      SELECT user_id, id as coop_id
      FROM cooperative_profiles
      WHERE id != ${coop.id}::uuid
        AND ST_DWithin(
          location::geography,
          (SELECT location::geography FROM cooperative_profiles WHERE id = ${coop.id}::uuid),
          ${rayonMeters}
        )
      LIMIT 50;
    `;
    for (const v of voisines) {
      recipients.push({
        user_id: v.user_id,
        audience_segment: 'COOPS_VOISINES',
        cooperative_id: v.coop_id,
      });
    }
  }

  // 3.c INDÉPENDANTS (FARMER sans coop dans le rayon)
  if (dto.audiences.includes('INDEPENDANTS')) {
    const rayonMeters = (dto.rayon_km ?? 50) * 1000;
    const independants = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT u.id
      FROM users u
      WHERE u.role = 'FARMER'
        AND u.cooperative_id IS NULL
        AND u.is_active = true
        AND ST_DWithin(
          u.location::geography,
          (SELECT location::geography FROM cooperative_profiles WHERE id = ${coop.id}::uuid),
          ${rayonMeters}
        )
      LIMIT 200;
    `;
    for (const ind of independants) {
      recipients.push({
        user_id: ind.id,
        audience_segment: 'INDEPENDANTS',
      });
    }
  }

  // 3.d Dédupliquer par user_id (un user peut être dans 2 audiences)
  const dedupedMap = new Map<string, typeof recipients[0]>();
  for (const r of recipients) {
    if (!dedupedMap.has(r.user_id)) dedupedMap.set(r.user_id, r);
  }
  const dedupedRecipients = Array.from(dedupedMap.values());

  if (dedupedRecipients.length === 0) {
    throw new BadRequestException(
      'Aucun destinataire trouvé pour les audiences sélectionnées.',
    );
  }

  // 4. Tout dans une transaction : sollicitation + recipients + dispatch
  const expiresAt = new Date(Date.now() + (dto.duree_jours ?? 7) * 86_400_000);

  return this.prisma.$transaction(async (tx) => {
    const sollicit = await tx.sollicitations_coop.create({
      data: {
        cooperative_id: coop.id,
        annonce_achat_id: dto.annonce_achat_id,
        initiated_by: userId,
        message: dto.message,
        audiences: dto.audiences,
        rayon_km: dto.rayon_km,
        quantite_cible_kg: annonce.quantite_kg,
        expires_at: expiresAt,
        status: 'OPEN',
        total_recipients: dedupedRecipients.length,
      },
    });

    // 5. Bulk insert des recipients
    await tx.sollicitation_recipients.createMany({
      data: dedupedRecipients.map((r) => ({
        sollicitation_id: sollicit.id,
        user_id: r.user_id,
        audience_segment: r.audience_segment,
        cooperative_id: r.cooperative_id,
      })),
    });

    // 6. Dispatch des notifications (in-app)
    //    Le SMS est délégué à AuthSmsProvider (Twilio mock en MVP).
    for (const r of dedupedRecipients) {
      const notif = await tx.notifications.create({
        data: {
          user_id: r.user_id,
          type: 'COOP_SOLLICITATION',
          titre: `Coopérative ${coop.nom} cherche du ${annonce.produits_agricoles?.nom ?? 'produit'}`,
          body: dto.message.slice(0, 200),
          data: {
            sollicitation_id: sollicit.id,
            annonce_achat_id: dto.annonce_achat_id,
            quantite_cible_kg: annonce.quantite_kg.toString(),
            audience_segment: r.audience_segment,
          } as Prisma.InputJsonValue,
          sent_at: new Date(),
        },
      });
      await tx.sollicitation_recipients.update({
        where: { sollicitation_id_user_id: { sollicitation_id: sollicit.id, user_id: r.user_id } },
        data: { notification_id: notif.id },
      });
    }

    return sollicit;
  }).then(async (sollicit) => {
    // 7. SMS hors TX (best effort — on ne fail pas la création si Twilio down)
    //    Le payload SMS contient un short URL deeplink → ouverture native.
    const phones = await this.prisma.users.findMany({
      where: { id: { in: dedupedRecipients.map((r) => r.user_id) } },
      select: { id: true, phone: true, langue: true },
    });
    for (const u of phones) {
      try {
        await this.smsProvider.send(
          u.phone,
          `FarmCash: la coop ${coop.nom} cherche ${annonce.quantite_kg}kg de produit. ` +
            `Ouvre l'app pour répondre.`,
        );
        await this.prisma.sollicitation_recipients.updateMany({
          where: { sollicitation_id: sollicit.id, user_id: u.id },
          data: { sms_sent_at: new Date() },
        });
      } catch (e) {
        this.logger.warn(`SMS KO user=${u.id} : ${e?.message}`);
      }
    }

    return {
      sollicitation_id: sollicit.id,
      recipients_count: {
        MEMBRES: dedupedRecipients.filter((r) => r.audience_segment === 'MEMBRES').length,
        COOPS_VOISINES: dedupedRecipients.filter((r) => r.audience_segment === 'COOPS_VOISINES').length,
        INDEPENDANTS: dedupedRecipients.filter((r) => r.audience_segment === 'INDEPENDANTS').length,
      },
      notifications_dispatched: dedupedRecipients.length,
    };
  });
}

async respondToSollicitation(userId: string, sollicitId: string, dto: RespondSollicitationDto) {
  // 1. Vérifier que user est destinataire
  const recipient = await this.prisma.sollicitation_recipients.findUnique({
    where: { sollicitation_id_user_id: { sollicitation_id: sollicitId, user_id: userId } },
    include: { sollicitations_coop: true },
  });
  if (!recipient) throw new ForbiddenException('Vous n\'êtes pas destinataire.');
  if (recipient.responded_at) throw new ConflictException('Déjà répondu.');
  if (recipient.sollicitations_coop.expires_at < new Date()) {
    throw new GoneException('Sollicitation expirée.');
  }
  if (dto.action === 'ACCEPTED' && !dto.quantite_kg) {
    throw new BadRequestException('quantite_kg requis si ACCEPTED.');
  }

  // 2. Update + agréger stats sur la sollicitation
  return this.prisma.$transaction(async (tx) => {
    await tx.sollicitation_recipients.update({
      where: { id: recipient.id },
      data: {
        responded_at: new Date(),
        response_action: dto.action,
        response_quantite_kg: dto.action === 'ACCEPTED' ? dto.quantite_kg : null,
      },
    });

    if (dto.action === 'ACCEPTED') {
      await tx.sollicitations_coop.update({
        where: { id: sollicitId },
        data: {
          total_responses: { increment: 1 },
          total_quantite_offerte: { increment: dto.quantite_kg ?? 0 },
        },
      });
    } else {
      await tx.sollicitations_coop.update({
        where: { id: sollicitId },
        data: { total_responses: { increment: 1 } },
      });
    }

    // Si quantité cible atteinte → CLOSED automatiquement
    const refreshed = await tx.sollicitations_coop.findUnique({ where: { id: sollicitId } });
    if (
      refreshed &&
      refreshed.quantite_cible_kg &&
      refreshed.total_quantite_offerte.greaterThanOrEqualTo(refreshed.quantite_cible_kg)
    ) {
      await tx.sollicitations_coop.update({
        where: { id: sollicitId },
        data: { status: 'FULFILLED' },
      });
      // Notifier la coop
      await tx.notifications.create({
        data: {
          user_id: refreshed.initiated_by,
          type: 'COOP_SOLLICITATION_FULFILLED',
          titre: 'Tonnage atteint',
          body: `Votre sollicitation a réuni ${refreshed.total_quantite_offerte} kg.`,
          data: { sollicitation_id: sollicitId } as Prisma.InputJsonValue,
        },
      });
    }

    return { recipient_id: recipient.id, ...dto };
  });
}
```

### Tests à prévoir

**Unitaires** (`sollicitations.service.spec.ts`) :

1. `createSollicitation` audience MEMBRES seule → recipients = membres actifs.
2. `createSollicitation` 3 audiences combinées → dédoublonnage correct.
3. `createSollicitation` refus si annonce PUBLIC (400).
4. `createSollicitation` refus si annonce SPECIFIC_COOPERATIVE ciblée autre coop (403).
5. `respondToSollicitation` ACCEPTED → incremente total_quantite_offerte.
6. `respondToSollicitation` rejette double-réponse (409).
7. `respondToSollicitation` rejette si expiré (410).
8. Auto-CLOSE quand total_quantite_offerte >= quantite_cible_kg.

**E2E** (`sollicitations.e2e-spec.ts`) :

1. Coop crée sollicitation → 2 membres reçoivent notif → 1 accepte 500 kg → stats à jour.
2. SMS provider mocké : vérifie que `sms_sent_at` est rempli quand le mock résout.
3. Tentative de créer en tant que FARMER → 403.

**Cas critiques** :

- Aucun destinataire trouvé (audience MEMBRES avec coop vide) → 400 clair.
- Race condition : 2 destinataires acceptent en parallèle au moment du seuil → un seul `FULFILLED`.
- Annonce d'achat supprimée pendant la sollicitation → `ON DELETE CASCADE` propage.

### Effort estimé

- DB migration : 2 h
- Backend (service + controller + DTOs + SMS hook) : 3 j
- Tests unitaires + e2e : 1 j
- **Total : 4.5 j**

---

## 3. Chantier — Data masking (anti-contournement) selon rôle

### Contexte produit

Maquettes concernées : toutes les fiches profil (`Producteur/profil_public.png`, `Buyer/seller_card.png`, `Buyer/list_offers.png`, `Transporteur/mission_detail.png`).

Risque business : si BUYER peut voir le téléphone du FARMER avant la commande, ils peuvent négocier hors-plateforme → la commission FarmCash disparaît (problème "Uber" classique).

Règle métier à appliquer à **toutes** les réponses contenant des PII (téléphone, nom complet, adresse précise) :

| Acteur observé | Téléphone | Nom complet | Géoloc | Photo |
|---|---|---|---|---|
| FARMER (vendeur) vu par BUYER (acheteur) sans commande | masqué (`+225 ** ** ** 78`) | prénom + initiale (`Sylvain K.`) | ville uniquement | OK |
| FARMER vu par BUYER **après** commande acceptée | proxy Twilio | nom complet | adresse approx (rayon 1 km) | OK |
| Tous acteurs vus par leur propre rôle | clair | clair | clair | clair |
| TRANSPORTER vu par BUYER | proxy Twilio | nom complet | OK (livraison) | OK |
| FARMER ↔ COOP membre | clair | clair | clair | clair |
| ADMIN | clair partout | clair partout | clair partout | clair |

Mécanisme : un **MaskingInterceptor** global qui :

1. Lit le user JWT de la requête.
2. Lit la ressource ciblée (via convention : retourne un objet avec `user_id` / `farmer_id` / etc.).
3. Détermine la relation user-courant → user-observé via `RelationshipResolver`.
4. Applique un set de transformations sur les champs sensibles selon la table ci-dessus.

### Migration DB (SQL)

Aucune migration. Ce chantier est 100% logique applicative.

### Modifications schema.prisma (extrait)

Aucune. On ne modifie pas le schéma — on transforme la sortie.

### DTOs (TypeScript prêts à coller)

Nouveau fichier : `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/shared/src/interceptors/masking.interceptor.ts`.

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { PrismaService } from '@farmcash/database';

/**
 * Décorateur posé sur le controller / handler pour skipper le masking
 * (ex: routes ADMIN d'audit où on a besoin du téléphone clair).
 */
export const SKIP_MASKING_KEY = 'skip_masking';
export const SkipMasking = () => SetMetadata(SKIP_MASKING_KEY, true);

/**
 * Décorateur pour déclarer quels champs sont sensibles dans la sortie.
 * Posé sur le DTO de réponse OU le handler.
 *
 * Ex:
 *   @MaskFields({
 *     phone: 'phone',
 *     full_name: 'name',
 *     coordinates: 'geo',
 *   })
 */
export const MASK_FIELDS_KEY = 'mask_fields';
export const MaskFields = (cfg: Record<string, MaskKind>) =>
  SetMetadata(MASK_FIELDS_KEY, cfg);

export type MaskKind = 'phone' | 'name' | 'geo' | 'address';
```

Et le service helper :

```typescript
// modules/shared/src/services/masking.service.ts

@Injectable()
export class MaskingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne le degré de visibilité d'un user observé par un viewer.
   * Granularité : FULL (clair) | PARTIAL (adresse approx, proxy phone) | MIN (initiales).
   */
  async resolveVisibility(
    viewerId: string,
    viewerRole: string,
    observedUserId: string,
  ): Promise<'FULL' | 'PARTIAL' | 'MIN'> {
    if (viewerId === observedUserId) return 'FULL';
    if (viewerRole === 'ADMIN') return 'FULL';

    // Existe-t-il une commande active entre les 2 ?
    const hasOrder = await this.prisma.commandes_vente.findFirst({
      where: {
        OR: [
          { buyer_id: viewerId, seller_id: observedUserId, status: { in: ['ACCEPTED','DELIVERED','COMPLETED'] } },
          { seller_id: viewerId, buyer_id: observedUserId, status: { in: ['ACCEPTED','DELIVERED','COMPLETED'] } },
        ],
      },
      select: { id: true },
    });
    if (hasOrder) return 'PARTIAL';

    // Existe-t-il une livraison active impliquant les 2 ?
    const hasShipment = await this.prisma.shipments.findFirst({
      where: {
        transporter_id: viewerId,
        status: { in: ['ACCEPTED','LOADING','IN_TRANSIT'] },
        commandes_vente: { OR: [{ buyer_id: observedUserId }, { seller_id: observedUserId }] },
      },
      select: { id: true },
    });
    if (hasShipment) return 'PARTIAL';

    // Coop ↔ membres ? (les 2 sont dans la même cooperative_members)
    const sameCoop = await this.prisma.cooperative_members.findFirst({
      where: { member_id: { in: [viewerId, observedUserId] } },
      select: { cooperative_id: true, member_id: true },
    });
    // TODO clarifier avec l'équipe : on veut "même cooperative_id pour les 2"
    // -> faire un count(distinct cooperative_id) = 1 group by member_id

    return 'MIN';
  }

  /**
   * Masque le téléphone. Garde l'indicatif + 2 derniers chiffres.
   * +2250709123456 → +225 ** ** ** 56
   */
  maskPhone(phone: string): string {
    if (!phone || phone.length < 4) return '+*** ** ** ** **';
    const last2 = phone.slice(-2);
    return `+225 ** ** ** ${last2}`;
  }

  maskName(fullName: string): string {
    if (!fullName) return 'Utilisateur';
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  }

  /** Réduit une coordonnée à 2 décimales (~1 km de précision). */
  maskGeo(coord: { lat: number; lng: number }): { lat: number; lng: number } {
    return {
      lat: Math.round(coord.lat * 100) / 100,
      lng: Math.round(coord.lng * 100) / 100,
    };
  }
}
```

### Endpoints REST

Aucun nouvel endpoint. L'interceptor s'applique transparente sur toutes les routes (sauf celles annotées `@SkipMasking()`).

Exemple d'usage côté controller existant (`marketplace.controller.ts`) :

```typescript
import { MaskFields } from '@farmcash/shared';

@Get('annonces/vente/:id')
@MaskFields({
  'users.phone': 'phone',
  'users.full_name': 'name',
  // coordinates est laissé tel quel mais arrondi à 2 décimales pour la carte publique
})
getAnnonceVenteById(...) { ... }
```

### Logique service (pseudo-code commenté)

```typescript
// MaskingInterceptor.intercept :
intercept(context: ExecutionContext, next: CallHandler) {
  const skip = this.reflector.get<boolean>(SKIP_MASKING_KEY, context.getHandler());
  if (skip) return next.handle();

  const cfg = this.reflector.get<Record<string, MaskKind>>(MASK_FIELDS_KEY, context.getHandler());
  if (!cfg) return next.handle();  // pas de mask déclaré → passthrough

  const req = context.switchToHttp().getRequest<Request>();
  const viewerId = (req.user as any)?.sub;
  const viewerRole = (req.user as any)?.role;

  return next.handle().pipe(
    map(async (payload) => {
      if (!viewerId) {
        // Visiteur anonyme : applique le masking maximum
        return this.applyMasking(payload, cfg, 'MIN');
      }
      // Pour chaque ressource observée dans payload, résoudre la visibility
      return await this.applyMaskingDeep(payload, cfg, viewerId, viewerRole);
    }),
  );
}

private async applyMaskingDeep(payload: any, cfg: any, viewerId: string, viewerRole: string) {
  // 1. Détecter l'observed user (champ "user_id" / "farmer_id" / "seller_id")
  const observedId =
    payload?.user_id ?? payload?.users?.id ?? payload?.farmer_id ?? payload?.seller_id;

  if (!observedId) return payload; // pas de PII identifiable, passthrough

  const visibility = await this.maskingService.resolveVisibility(
    viewerId, viewerRole, observedId,
  );
  if (visibility === 'FULL') return payload;

  // 2. Appliquer les masks selon cfg
  for (const [path, kind] of Object.entries(cfg)) {
    const value = getByPath(payload, path);
    if (value == null) continue;
    let masked = value;
    if (kind === 'phone') {
      masked = visibility === 'PARTIAL'
        ? await this.twilioProxy.getProxyNumber(viewerId, observedId)
        : this.maskingService.maskPhone(value);
    }
    if (kind === 'name') masked = this.maskingService.maskName(value);
    if (kind === 'geo')  masked = this.maskingService.maskGeo(value);
    setByPath(payload, path, masked);
  }
  return payload;
}
```

> NOTE technique importante : l'interceptor doit traiter aussi bien les objets seuls que les listes (`{data: [...]}`). Une util récursive `walkAndMask` est nécessaire.

### Tests à prévoir

**Unitaires** (`masking.service.spec.ts`) :

1. `maskPhone('+2250709123456')` → `'+225 ** ** ** 56'`.
2. `maskName('Sylvain Kouassi')` → `'Sylvain K.'`.
3. `maskName('Aïcha')` → `'Aïcha'` (mono-mot).
4. `maskGeo` : précision 2 décimales.
5. `resolveVisibility` : self → FULL.
6. `resolveVisibility` : ADMIN → FULL.
7. `resolveVisibility` : pas de relation → MIN.
8. `resolveVisibility` : commande COMPLETED → PARTIAL.

**E2E** (`masking.e2e-spec.ts`) :

1. BUYER liste annonces de vente : `users.phone` est masqué.
2. BUYER consulte une annonce dont il a une commande acceptée : `users.phone` est un proxy Twilio.
3. ADMIN consulte la même : `users.phone` est clair.
4. Le FARMER consulte sa propre annonce : `users.phone` est clair.

**Cas critiques** :

- Pour `getAnnoncesVente` qui renvoie une liste : chaque item doit être masqué indépendamment (un BUYER peut avoir une commande avec un seul des farmers de la liste).
- Le `MaskingInterceptor` doit s'exécuter AVANT le `TransformInterceptor` (sinon il masque la structure enveloppée). À gérer dans `app.module.ts` via l'ordre des `APP_INTERCEPTOR` providers.
- Performance : `resolveVisibility` fait 3 SELECTs par observed user. Pour les listes longues → cache mémoire 60 s ou batching.

### Effort estimé

- DB migration : 0 h
- Backend (interceptor + service + décorateurs + intégration) : 3 j
- Annotations sur les controllers existants (~10 endpoints) : 0.5 j
- Tests unitaires + e2e : 1 j
- **Total : 4.5 j**

---

## 4. Chantier — Wallet recharger multi-méthodes

### Contexte produit

Maquettes concernées : `Buyer/wallet_recharger.png`, `Buyer/wallet_methode.png`, `Buyer/wallet_recap.png`.

Le BUYER veut pouvoir charger son wallet FarmCash en avance (au lieu de payer commande par commande) pour profiter d'offres flash. Aujourd'hui seul `processPayout` (sortir l'argent) existe — il faut le symétrique côté entrée.

Une recharge :

1. Le BUYER choisit un moyen de paiement (`moyen_de_payement.provider`).
2. Le BUYER saisit un montant.
3. Le backend appelle le provider mocké (OM/MTN/Moov/Wave) → reçoit `PENDING`.
4. Le webhook provider arrive (cf. `handleProviderWebhook` existant) → bascule à `SUCCESS` et incrémente `wallet.balance`.

Réutilise l'infra : `transactions`, `moyen_de_payement`, `handleProviderWebhook`.

### Migration DB (SQL)

```sql
-- Migration 20260520_wallet_topup_idempotency.sql

-- Aucune nouvelle table. On utilise transactions.type = 'TOPUP'.
-- On ajoute un index pour le filtrage rapide par type.
CREATE INDEX idx_transactions_type ON transactions(type);

-- Constraint anti-double-credit basé sur idempotency_key
-- (la colonne existe déjà mais sans unique constraint).
CREATE UNIQUE INDEX uniq_transactions_idempotency
  ON transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

### Modifications schema.prisma (extrait)

```prisma
model transactions {
  // ... champs existants
  // (ajouter dans les contraintes Prisma au prochain pull)
  @@unique([idempotency_key], map: "uniq_transactions_idempotency")
}
```

### DTOs (TypeScript prêts à coller)

Fichier cible : `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/finance/src/dto/finance.dto.ts` — ajouter en fin :

```typescript
// ===================================================================
//  TOPUP — recharger son wallet via Mobile Money
// ===================================================================

export class TopupWalletDto {
  /** Montant à recharger en XOF. Min 500, max 1 000 000 (limite Mobile Money). */
  @ApiProperty({ example: 25000 })
  @IsInt()
  @Min(500)
  @Max(1_000_000)
  amount: number;

  @ApiProperty({ description: 'ID du moyen de paiement (vérifié serveur)' })
  @IsUUID()
  @IsNotEmpty()
  payment_method_id: string;

  /**
   * Clé d'idempotence générée côté client (UUID v4).
   * Garantit qu'une retry réseau ne crée pas un 2e crédit.
   */
  @ApiProperty({ description: 'UUID v4 pour idempotence' })
  @IsUUID()
  @IsNotEmpty()
  idempotency_key: string;
}

export class TopupWalletResponseDto {
  @ApiProperty()
  transaction_id: string;

  @ApiProperty({ enum: ['PENDING', 'SUCCESS'] })
  status: string;

  @ApiProperty({ description: 'Référence provider (utile pour réconciliation)' })
  provider_ref: string;

  @ApiProperty({ description: 'Solde wallet après recharge (si SUCCESS immédiat)' })
  new_balance?: number;
}
```

### Endpoints REST

```
POST /api/finance/wallet/topup
Auth: Bearer JWT
Roles: tous (sauf ADMIN qui n'a pas de wallet métier)
Body: TopupWalletDto
Response 200 ou 202:
  - 200 si provider mocké répond ACCEPTED synchrone → balance immédiatement créditée
  - 202 si provider répond PENDING → balance créditée au webhook
Body de réponse: TopupWalletResponseDto
Errors:
  - 400 si payment_method invalide ou inactif
  - 403 si wallet gelé
  - 409 si idempotency_key déjà utilisée (renvoie la TX existante)
  - 422 si provider échoue immédiatement
```

```
GET /api/finance/wallet/topup/:transactionId
Auth: Bearer JWT
Roles: ownership (transactions.user_id === user.sub)
Response 200: { transaction_id, status, provider_status, created_at }
Errors:
  - 404 si introuvable
  - 403 si pas owner
```

### Logique service (pseudo-code commenté)

Fichier cible : `/Users/STEPH/Desktop/farmcash-ai/farmcash-backend/modules/finance/src/finance.service.ts`.

```typescript
async topupWallet(userId: string, dto: TopupWalletDto): Promise<TopupWalletResponseDto> {
  // 1. Idempotence FORTE : si la même key existe déjà, renvoyer la TX
  const existing = await this.prisma.transactions.findUnique({
    where: { idempotency_key: dto.idempotency_key },
  });
  if (existing) {
    if (existing.user_id !== userId) {
      throw new ConflictException('Clé d\'idempotence détournée.');
    }
    return {
      transaction_id: existing.id,
      status: existing.status,
      provider_ref: existing.provider_ref ?? '',
      new_balance: undefined,
    };
  }

  // 2. Vérifications classiques
  const moyen = await this.prisma.moyen_de_payement.findFirst({
    where: { id: dto.payment_method_id, user_id: userId, is_active: true },
  });
  if (!moyen) throw new BadRequestException('Moyen de paiement invalide.');

  const wallet = await this.getOrCreateWallet(userId);
  if (wallet.is_frozen) throw new ForbiddenException('Wallet gelé.');

  // 3. Créer la transaction PENDING
  const tx = await this.prisma.transactions.create({
    data: {
      user_id: userId,
      type: 'TOPUP',  // nouveau type, à ajouter à l'enum TransactionType
      montant: dto.amount,
      balance_avant: wallet.balance,
      balance_apres: wallet.balance, // sera mis à jour à la confirmation
      status: 'PENDING',
      description: `Recharge wallet (${moyen.provider}, ${moyen.phone_display})`,
      provider: moyen.provider,
      idempotency_key: dto.idempotency_key,
    },
  });

  // 4. Appeler le provider (mocké → réponse synchrone ACCEPTED)
  const providerRef = `${moyen.provider}-TOPUP-${Date.now().toString(36)}`;
  const providerResponse = await this.mobileProvider.initiateTopup({
    provider: moyen.provider,
    amount: dto.amount,
    phone: moyen.phone_display,
    reference: providerRef,
  });
  // providerResponse = { status: 'ACCEPTED' | 'PENDING' | 'FAILED', message? }

  if (providerResponse.status === 'FAILED') {
    await this.prisma.transactions.update({
      where: { id: tx.id },
      data: { status: 'FAILED', failed_reason: providerResponse.message },
    });
    throw new UnprocessableEntityException(`Provider refus: ${providerResponse.message}`);
  }

  if (providerResponse.status === 'PENDING') {
    return {
      transaction_id: tx.id,
      status: 'PENDING',
      provider_ref: providerRef,
    };
  }

  // 5. ACCEPTED synchrone → créditer maintenant
  return this.confirmTopup(tx.id, providerRef);
}

/**
 * Confirme la recharge : appelé soit synchrone (si provider mocké ACCEPTED),
 * soit asynchrone par handleProviderWebhook quand le vrai callback arrive.
 *
 * Idempotent : si la TX est déjà SUCCESS, ne refait rien.
 */
async confirmTopup(transactionId: string, providerRef: string) {
  return this.prisma.$transaction(async (prisma) => {
    const tx = await prisma.transactions.findUnique({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException('Transaction introuvable.');
    if (tx.status === 'SUCCESS') {
      // Idempotent : retourner l'état actuel
      const w = await prisma.wallets.findUnique({
        where: { user_id_currency: { user_id: tx.user_id, currency: 'XOF' } },
      });
      return {
        transaction_id: tx.id,
        status: 'SUCCESS',
        provider_ref: providerRef,
        new_balance: w?.balance.toNumber(),
      };
    }
    if (tx.status !== 'PENDING') {
      throw new ConflictException(`Statut invalide: ${tx.status}`);
    }

    const wallet = await this.lockWallet(prisma, tx.user_id);
    const balanceApres = wallet.balance.plus(tx.montant);
    await prisma.wallets.update({
      where: { id: wallet.id },
      data: { balance: balanceApres },
    });
    await prisma.transactions.update({
      where: { id: tx.id },
      data: {
        status: 'SUCCESS',
        balance_apres: balanceApres,
        provider_ref: providerRef,
        provider_status: 'ACCEPTED',
      },
    });

    // Notif info
    await this.notifications.create({
      user_id: tx.user_id,
      type: 'WALLET_TOPUP_SUCCESS',
      titre: 'Recharge confirmée',
      body: `Votre wallet a été rechargé de ${tx.montant} XOF.`,
    });

    return {
      transaction_id: tx.id,
      status: 'SUCCESS',
      provider_ref: providerRef,
      new_balance: balanceApres.toNumber(),
    };
  });
}
```

> NOTE : ajouter `TOPUP` à `enum TransactionType` dans `finance.dto.ts:54`.
> Mettre à jour `handleProviderWebhook` (cf. `finance.service.ts:1301`) pour router les TX `type=TOPUP` vers `confirmTopup` au lieu de `confirmPayment`.

### Tests à prévoir

**Unitaires** (`finance.service.spec.ts` — section topup) :

1. `topupWallet` provider ACCEPTED synchrone → wallet.balance += amount.
2. `topupWallet` provider PENDING → tx en PENDING, balance inchangée.
3. `topupWallet` provider FAILED → 422 + tx en FAILED.
4. `topupWallet` idempotency_key réutilisée par même user → renvoie la TX existante.
5. `topupWallet` idempotency_key d'un autre user → 409.
6. `confirmTopup` idempotent : 2e appel ne re-crédite pas.
7. `topupWallet` wallet gelé → 403.

**E2E** (`finance.e2e-spec.ts`) :

1. POST /topup ACCEPTED → balance visible via `GET /wallet`.
2. POST /topup PENDING → webhook arrive → balance créditée.
3. POST /topup avec amount < 500 → 400.

**Cas critiques** :

- Race condition : 2 webhooks parallèles pour la même idempotency_key → un seul crédit (grâce au `lockWallet` + statut PENDING→SUCCESS atomic).
- Provider qui répond ACCEPTED puis envoie un webhook FAILED → on garde SUCCESS (la double confirmation est filtrée par `if (tx.status === 'SUCCESS') return`).

### Effort estimé

- DB migration : 1 h
- Backend (service + controller + DTOs + intégration webhook) : 2 j
- Tests unitaires + e2e : 1 j
- **Total : 3 j**

---

## 5. Chantier (low prio) — Téléphone proxy + notif prévision J-5

### Contexte produit

Deux features secondaires regroupées car peu de code chacune.

**5.a Téléphone proxy (Twilio)** — Maquette : `Buyer/seller_card.png` (CTA "Appeler le vendeur" → enregistré + masqué).
Quand le BUYER a une commande active avec un FARMER, il doit pouvoir l'appeler **sans voir le vrai numéro** (cf. règle "PARTIAL" du chantier 3). On utilise Twilio Proxy : on alloue une paire (vrai_num_buyer → numéro_FarmCash → vrai_num_seller), valable 14 jours, suivie pour QA et facturation.

**5.b Notif prévision J-5** — Maquettes : `Producteur/previsions_dashboard.png`, `Producteur/notif_recolte.png`.
Le FARMER déclare une prévision avec `date_recolte_prev`. À J-5 (5 jours avant la date), il doit recevoir une notif "Pense à publier ton annonce". Aucun cron n'existe.

### Migration DB (SQL)

```sql
-- Migration 20260521_phone_proxy_sessions.sql

CREATE TABLE phone_proxy_sessions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  caller_user_id      UUID NOT NULL REFERENCES users(id),
  callee_user_id      UUID NOT NULL REFERENCES users(id),
  commande_id         UUID REFERENCES commandes_vente(id),
  proxy_phone         VARCHAR(20) NOT NULL,
  provider_session_id VARCHAR(120),
  expires_at          TIMESTAMPTZ NOT NULL,
  call_count          INT DEFAULT 0,
  total_duration_sec  INT DEFAULT 0,
  last_call_at        TIMESTAMPTZ,
  status              VARCHAR(20) DEFAULT 'ACTIVE',  -- ACTIVE / EXPIRED / REVOKED
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_phone_proxy_caller ON phone_proxy_sessions(caller_user_id);
CREATE INDEX idx_phone_proxy_callee ON phone_proxy_sessions(callee_user_id);
CREATE INDEX idx_phone_proxy_commande ON phone_proxy_sessions(commande_id);
```

Pas de migration pour 5.b — on ajoute un cron qui lit `previsions_production`.

### Modifications schema.prisma (extrait)

```prisma
model phone_proxy_sessions {
  id                  String          @id @default(dbgenerated("uuid_generate_v4()")) @db.Uuid
  caller_user_id      String          @db.Uuid
  callee_user_id      String          @db.Uuid
  commande_id         String?         @db.Uuid
  proxy_phone         String          @db.VarChar(20)
  provider_session_id String?         @db.VarChar(120)
  expires_at          DateTime        @db.Timestamptz(6)
  call_count          Int             @default(0)
  total_duration_sec  Int             @default(0)
  last_call_at        DateTime?       @db.Timestamptz(6)
  status              String          @default("ACTIVE") @db.VarChar(20)
  created_at          DateTime        @default(now()) @db.Timestamptz(6)
  // relations omises pour brièveté (caller/callee/commande)
}
```

### DTOs (TypeScript prêts à coller)

```typescript
// modules/messaging/src/dto/phone-proxy.dto.ts

export class CreateProxyCallDto {
  @ApiProperty({ description: 'User cible (le callee)' })
  @IsUUID()
  callee_user_id: string;

  @ApiPropertyOptional({ description: 'Commande contexte (obligatoire pour FARMER↔BUYER)' })
  @IsOptional()
  @IsUUID()
  commande_id?: string;
}

export class ProxyCallResponseDto {
  @ApiProperty({ example: '+2250123456789' })
  proxy_phone: string;

  @ApiProperty()
  expires_at: string;

  @ApiProperty()
  session_id: string;
}
```

### Endpoints REST

```
POST /api/messaging/phone-proxy
Auth: Bearer JWT
Roles: tous
Body: CreateProxyCallDto
Response 201: ProxyCallResponseDto
Errors:
  - 403 si pas de relation commande active entre caller et callee
  - 404 si callee_user_id introuvable

POST /api/messaging/phone-proxy/webhook
Auth: signature Twilio (HMAC-SHA1 via header X-Twilio-Signature)
Body: événement Twilio (call.completed, call.duration, ...)
Response 200
```

### Logique service (pseudo-code commenté)

```typescript
async createProxyCall(callerId: string, dto: CreateProxyCallDto) {
  // 1. Vérifier qu'il y a bien une relation autorisée
  //    (commande active OU livraison active OU même coop)
  const allowed = await this.maskingService.resolveVisibility(
    callerId, /* role= */ '', dto.callee_user_id,
  );
  if (allowed === 'MIN') {
    throw new ForbiddenException('Pas de relation justifiant un appel proxy.');
  }

  // 2. Réutiliser une session existante si encore valide (< 14 j)
  const existing = await this.prisma.phone_proxy_sessions.findFirst({
    where: {
      caller_user_id: callerId,
      callee_user_id: dto.callee_user_id,
      status: 'ACTIVE',
      expires_at: { gt: new Date() },
    },
  });
  if (existing) {
    return {
      proxy_phone: existing.proxy_phone,
      expires_at: existing.expires_at.toISOString(),
      session_id: existing.id,
    };
  }

  // 3. Allouer un numéro via TwilioProxyProvider (mocké en dev)
  const allocated = await this.twilioProxy.createSession({
    callerPhone: (await this.prisma.users.findUnique({ where: { id: callerId } }))!.phone,
    calleePhone: (await this.prisma.users.findUnique({ where: { id: dto.callee_user_id } }))!.phone,
  });

  // 4. Persister
  const session = await this.prisma.phone_proxy_sessions.create({
    data: {
      caller_user_id: callerId,
      callee_user_id: dto.callee_user_id,
      commande_id: dto.commande_id,
      proxy_phone: allocated.proxyPhone,
      provider_session_id: allocated.providerSessionId,
      expires_at: new Date(Date.now() + 14 * 86_400_000),
      status: 'ACTIVE',
    },
  });

  return {
    proxy_phone: session.proxy_phone,
    expires_at: session.expires_at.toISOString(),
    session_id: session.id,
  };
}
```

Cron J-5 :

```typescript
// modules/marketplace/src/previsions-reminder.cron.ts

@Injectable()
export class PrevisionsReminderCron implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get('DISABLE_PREVISIONS_REMINDER') === 'true') return;
    // Tourne 1×/jour, démarre 2 min après le boot
    setTimeout(() => this.runOnce(), 2 * 60 * 1000);
    this.timer = setInterval(() => this.runOnce(), 24 * 60 * 60 * 1000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async runOnce() {
    // Fenêtre : date_recolte_prev entre J+4 et J+6 (tolerance ±1j si cron raté)
    const today = new Date();
    const j5min = new Date(today.getTime() + 4 * 86_400_000);
    const j5max = new Date(today.getTime() + 6 * 86_400_000);

    const dueRows = await this.prisma.previsions_production.findMany({
      where: {
        status: 'OPEN',
        date_recolte_prev: { gte: j5min, lte: j5max },
        converted_to_annonce_id: null,
      },
      include: { produits_agricoles: { select: { nom: true } } },
    });

    for (const p of dueRows) {
      // Anti-spam : check si on a déjà notifié dans les 6 derniers jours
      const recent = await this.prisma.notifications.findFirst({
        where: {
          user_id: p.farmer_id,
          type: 'PREVISION_J5_REMINDER',
          created_at: { gte: new Date(Date.now() - 6 * 86_400_000) },
          data: { path: ['prevision_id'], equals: p.id },
        },
      });
      if (recent) continue;

      await this.notifications.create({
        user_id: p.farmer_id,
        type: 'PREVISION_J5_REMINDER',
        titre: `Récolte ${p.produits_agricoles?.nom ?? 'à venir'} dans 5 jours`,
        body: 'Publie ton annonce maintenant pour trouver des acheteurs.',
        data: { prevision_id: p.id } as Prisma.InputJsonValue,
      });
    }
  }
}
```

> Penser à enregistrer `PrevisionsReminderCron` dans le `MarketplaceModule` providers (à côté de `ReservationsExpirationCron`).

### Tests à prévoir

**Unitaires** :

1. `createProxyCall` : si session active existe → la réutilise (pas de nouvelle allocation).
2. `createProxyCall` : refuse si pas de relation (visibility MIN).
3. `PrevisionsReminderCron.runOnce` : prévision J+5 → notif créée.
4. `PrevisionsReminderCron.runOnce` : 2 runs successifs → 1 seule notif (anti-spam).

**E2E** :

1. BUYER demande proxy pour SELLER avec commande active → reçoit un numéro.
2. Webhook Twilio "call.completed" → `call_count++` et `total_duration_sec` rempli.

**Cas critiques** :

- Twilio provider DOWN → on lève 503 plutôt que créer une session sans numéro.
- Cron qui rate 1 jour → quand il tourne, il rattrape grâce à la fenêtre J+4/J+6.

### Effort estimé

- DB migration : 0.5 h
- Backend proxy (service + controller + provider mock) : 1.5 j
- Backend cron prévision J-5 : 0.5 j
- Tests unitaires + e2e : 0.5 j
- **Total : 2.5 j**

---

## Roadmap d'implémentation (Gantt simplifié)

Hypothèse : 1 dev backend full-time, démarrage 2026-05-20.

```
Semaine 1 (20-24 mai)
  [Chantier 4 — Wallet topup        ] ▓▓▓▓░░░░░░░░░░░░░░░░  3.0j
                                    └─ déblocage pour les flow BUYER

Semaine 2 (27-31 mai)
  [Chantier 1 — QR scan + auto-release] ▓▓▓▓▓░░░░░░░░░░░░░  3.5j
                                    └─ amélioration trésorerie producteurs

Semaine 3 (3-7 juin)
  [Chantier 2 — Sollicitations coop ] ▓▓▓▓▓▓▓░░░░░░░░░░░░  4.5j
                                    └─ critique pour onboarding coopératives

Semaine 4 (10-14 juin)
  [Chantier 3 — Data masking        ] ▓▓▓▓▓▓▓░░░░░░░░░░░░  4.5j
                                    └─ anti-contournement (priorité business)

Semaine 5 (17-19 juin)
  [Chantier 5 — Proxy + cron J-5    ] ▓▓▓▓░░░░░░░░░░░░░░░  2.5j
                                    └─ bonus, peut glisser sans bloquer

Buffer + QA finale (20-21 juin) ▓▓
```

Total : 18 jours hommes, soit 4 semaines de développement effectif + 1 semaine de QA.

Dépendances critiques :

- Chantier 3 (masking) consomme `MaskingService.resolveVisibility` → Chantier 5 (proxy) doit attendre 3.
- Chantier 1 (QR) réutilise `releaseEscrow` existant → 0 dépendance.
- Chantier 2 (sollicitations) réutilise `NotificationsService` + `SmsProvider` → 0 dépendance.
- Chantier 4 (topup) réutilise `handleProviderWebhook` → 0 dépendance.

---

## Annexe A — Conventions FarmCash

Rappels du style à respecter pour chaque chantier (cf. `modules/marketplace/`, `modules/finance/`, `guide_backend.md` complet).

### A.1 Structure d'un module

```
modules/<nom>/src/
├── dto/                       # Validation entrée (class-validator)
├── entities/                  # Forme de sortie (réponses API)
├── guards/                    # Sécurité spécifique (optionnel)
├── <nom>.module.ts            # Déclaration NestJS
├── <nom>.controller.ts        # Routes HTTP
├── <nom>.service.ts           # Logique métier (appels Prisma)
└── index.ts                   # Exports publics (@farmcash/<nom>)
```

### A.2 Convention de nommage des routes

- Préfixe global : `/api`.
- Préfixe module : `/api/<module>` (`marketplace`, `finance`, `coop`, `logistics`).
- Verbes REST stricts :
  - `GET /xxx` liste / détail (public ou auth selon besoin).
  - `POST /xxx` création (CREATED 201).
  - `PUT /xxx/:id` update complet (ownership check obligatoire).
  - `DELETE /xxx/:id` suppression (idempotente).
- Actions custom : `POST /xxx/:id/<action>` (`/scan-pickup`, `/respond`, `/close`).

### A.3 DTO

- Toujours `class-validator` + `class-transformer`.
- Décorer chaque champ avec `@ApiProperty()` ou `@ApiPropertyOptional()` (génère Swagger).
- Pour les objets imbriqués : `@ValidateNested()` + `@Type(() => Sub)`.
- Pour les enums : `@IsEnum(Foo)` avec l'enum TypeScript qui mirror l'enum SQL.
- Réponses : préférer une classe `XxxResponseDto` plutôt qu'un objet inline (utile pour Swagger).

### A.4 Envelope de réponse

L'`TransformInterceptor` global enveloppe **automatiquement** toutes les responses :

```json
{
  "success": true,
  "data": <retour de votre controller>,
  "timestamp": "2026-05-17T12:34:56.789Z"
}
```

Ne pas wrapper manuellement. Pour skipper l'envelope (téléchargement de fichier, SSE) : `@SkipTransform()`.

### A.5 Format d'erreur

L'`AllExceptionsFilter` global normalise :

```json
{
  "success": false,
  "statusCode": 403,
  "timestamp": "...",
  "path": "/api/...",
  "error": { "message": "...", "code": "OPTIONAL_CODE" }
}
```

Lever des exceptions NestJS natives (`BadRequestException`, `ForbiddenException`, `NotFoundException`, `ConflictException`, etc.). Le filter mappe aussi les `Prisma.PrismaClientKnownRequestError` (P2002 → 409, P2025 → 404).

### A.6 Auth + Roles

```typescript
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('FARMER')  // ou 'BUYER', 'COOPERATIVE', 'TRANSPORTER', 'EXPORTER', 'ADMIN'
@ApiBearerAuth()
```

Récupérer le user courant : `@CurrentUser() user: AuthenticatedUser` (`user.sub` = uuid, `user.role` = role).

### A.7 Transactions Prisma

- Toute action qui touche **wallets** ou **stocks** doit être dans un `prisma.$transaction()`.
- Pour les wallets, utiliser **toujours** `lockWallet(tx, userId)` (SELECT FOR UPDATE) avant écriture.
- Pour 2 wallets, utiliser `lockTwoWallets(tx, a, b)` (ordre déterministe = pas de deadlock).
- Ne pas mélanger Prisma calls et `$queryRaw` au sein de la même TX sans raison (lisibilité).

### A.8 Logging

- Chaque service a un `private readonly logger = new Logger(XxxService.name);`.
- Log les opérations métier critiques (`log()` pour SUCCESS, `warn()` pour anomalies bénignes, `error()` pour vrais bugs).
- Ne **jamais** logger un PIN, OTP, token JWT, secret HMAC.

### A.9 Décimaux

- Tous les montants en `Prisma.Decimal` (15,2 en DB).
- Ne jamais faire de `parseFloat()` sur un montant — perdre l'arrondi = produire de l'argent fantôme.
- Conversion DTO (number JS) → Decimal : `new Prisma.Decimal(dto.amount.toString())`.

### A.10 Tests

- Suite Jest. Spec à côté du fichier (`xxx.service.spec.ts` dans le même dir).
- E2E dans `/test/<module>.e2e-spec.ts`. Utiliser le JWT mock fourni par `test/auth-helpers.ts`.
- Mock le `PrismaService` via `jest.fn()` pour les unitaires, vraie DB de test pour les E2E.
- Toujours un cas nominal + au moins 2 cas d'erreur par méthode publique.

### A.11 Variables d'environnement

À ajouter dans `.env` pour les chantiers V2 :

```
QR_PICKUP_SECRET=<32+ chars random>
QR_PICKUP_TTL_SECONDS=900
QR_PICKUP_MAX_DISTANCE_METERS=500

TWILIO_PROXY_ACCOUNT_SID=<si Twilio réel>
TWILIO_PROXY_AUTH_TOKEN=<si Twilio réel>
TWILIO_PROXY_SERVICE_SID=<si Twilio réel>
TWILIO_PROXY_MOCK=true   # dev/test

DISABLE_PREVISIONS_REMINDER=false

SOLLICITATION_DEFAULT_DURATION_DAYS=7
SOLLICITATION_MAX_RADIUS_KM=500

MASKING_VISIBILITY_CACHE_TTL_SECONDS=60
```

---

## Annexe B — Glossaire

| Terme | Signification |
|---|---|
| Annonce de vente | Offre FARMER de vendre du produit (table `annonces_vente`) |
| Annonce d'achat | Demande BUYER d'acheter (table `annonces_achat`, avec `target_audience`) |
| Prévision | Déclaration prévisionnelle de récolte (table `previsions_production`) |
| Réservation | Acompte 10% sur une prévision (table `reservations_previsions`) |
| Sollicitation | Mobilisation par une coop de plusieurs audiences pour fulfiller une demande |
| Escrow PRODUCT | Argent producteur en attente, libéré à l'enlèvement scanné ou à la livraison |
| Escrow TRANSPORT | Argent transporteur en attente, libéré à la livraison confirmée |
| Payin | Crédit Mobile Money → escrow (`TransactionType.PAYIN`) |
| Payout | Débit wallet → Mobile Money (`TransactionType.PAYOUT`) |
| Topup | Crédit Mobile Money → wallet (nouveau `TransactionType.TOPUP`) |
| Release | Libération escrow → balance bénéficiaire (`TransactionType.RELEASE`) |
| Visibility | Niveau de détail PII renvoyé par l'API (FULL / PARTIAL / MIN) |
| Proxy phone | Numéro intermédiaire Twilio masquant les vrais numéros |
| Lot | Regroupement de contributions FARMERs (table `lots` + `lot_contributions`) |

---

*Fin du document — 5 chantiers documentés, prêt à implémenter.*
