// =====================================================================
//  SERVICE : LogisticsService
//  ---------------------------------------------------------------------
//  Cœur métier du module logistique. Trois domaines :
//
//   1. Routes transporteur : un TRANSPORTER déclare quelles zones
//      origine→destination il dessert, avec son tarif au kg + tarif min
//      + capacité max. Il peut activer/désactiver à la demande.
//
//   2. Quote (devis) : à la commande, OrdersService demande "qui peut
//      transporter X kg de Bouaké à Abidjan, à quel prix ?". On retourne
//      la liste des offres triées par tarif croissant. L'app mobile (ou
//      Orders) prend généralement le moins cher.
//
//   3. Shipments : créés automatiquement par OrdersService à la commande,
//      avec transporter_id=null. Les TRANSPORTERS dont la route matche
//      voient la mission disponible et peuvent l'accepter (premier
//      arrivé, premier servi). Ensuite : LOADING → IN_TRANSIT →
//      DELIVERED. Position GPS périodique, preuve photo à la livraison.
// =====================================================================

import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, shipment_status } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { FinanceService } from '@farmcash/finance';
import { EscrowKind } from '@farmcash/finance';
import { NotificationsService } from '@farmcash/notifications';
import { NotificationType } from '@farmcash/notifications';
import {
  CreateTransporterRouteDto,
  QuoteTransportQueryDto,
  UpdateTransporterRouteDto,
} from './dto/routes.dto';
import {
  MarkDeliveredDto,
  ScanPickupDto,
  ShipmentStatus,
  StartLoadingDto,
  TrackPositionDto,
} from './dto/shipments.dto';

/**
 * Offre de transport sur un trajet donné, pour la quantité demandée.
 */
export interface TransportQuote {
  route_id: string;
  transporter_id: string;
  transporter_name: string;
  rating: number;
  tarif_total: number;
  delai_typique?: string | null;
}

/** State machine des shipments — calquée sur l'enum SQL. */
const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  REQUESTED: [ShipmentStatus.ACCEPTED, ShipmentStatus.CANCELLED],
  ACCEPTED: [ShipmentStatus.LOADING, ShipmentStatus.CANCELLED],
  LOADING: [ShipmentStatus.IN_TRANSIT, ShipmentStatus.CANCELLED],
  IN_TRANSIT: [ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED],
  DELIVERED: [],
  CANCELLED: [],
};

@Injectable()
export class LogisticsService {
  private readonly logger = new Logger(LogisticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ===================================================================
  //  ROUTES TRANSPORTEUR
  // ===================================================================

  async createRoute(transporterId: string, dto: CreateTransporterRouteDto) {
    if (dto.origin_zone.trim() === dto.destination_zone.trim()) {
      throw new BadRequestException("L'origine et la destination doivent différer.");
    }
    try {
      return await this.prisma.transporter_routes.create({
        data: {
          transporter_id: transporterId,
          origin_zone: dto.origin_zone.trim(),
          destination_zone: dto.destination_zone.trim(),
          tarif_kg: dto.tarif_kg,
          tarif_minimum: dto.tarif_minimum ?? 0,
          capacite_max_kg: dto.capacite_max_kg,
          delai_typique: dto.delai_typique,
          is_active: true,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Vous avez déjà déclaré cette route. Utilisez PUT pour la modifier.',
        );
      }
      throw e;
    }
  }

  async getMyRoutes(transporterId: string) {
    return this.prisma.transporter_routes.findMany({
      where: { transporter_id: transporterId },
      orderBy: [{ is_active: 'desc' }, { origin_zone: 'asc' }],
    });
  }

  async updateRoute(
    transporterId: string,
    id: string,
    dto: UpdateTransporterRouteDto,
  ) {
    const route = await this.prisma.transporter_routes.findFirst({
      where: { id, transporter_id: transporterId },
    });
    if (!route) throw new NotFoundException('Route introuvable.');

    return this.prisma.transporter_routes.update({
      where: { id },
      data: {
        ...(dto.tarif_kg !== undefined && { tarif_kg: dto.tarif_kg }),
        ...(dto.tarif_minimum !== undefined && { tarif_minimum: dto.tarif_minimum }),
        ...(dto.capacite_max_kg !== undefined && {
          capacite_max_kg: dto.capacite_max_kg,
        }),
        ...(dto.delai_typique !== undefined && { delai_typique: dto.delai_typique }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });
  }

  async deleteRoute(transporterId: string, id: string) {
    const route = await this.prisma.transporter_routes.findFirst({
      where: { id, transporter_id: transporterId },
    });
    if (!route) throw new NotFoundException('Route introuvable.');
    await this.prisma.transporter_routes.update({
      where: { id },
      data: { is_active: false },
    });
    return { message: 'Route désactivée.' };
  }

  // ===================================================================
  //  DEVIS
  // ===================================================================

  /**
   * Retourne les offres de transport disponibles pour un trajet+quantité.
   * Triées par tarif total croissant (le moins cher en premier).
   *
   * Formule : tarif_total = MAX(tarif_minimum, tarif_kg × quantite_kg)
   * Filtre : capacite_max_kg >= quantite_kg, route active.
   */
  async getQuotes(query: QuoteTransportQueryDto): Promise<TransportQuote[]> {
    const candidates = await this.prisma.transporter_routes.findMany({
      where: {
        origin_zone: query.origin_zone,
        destination_zone: query.destination_zone,
        is_active: true,
        capacite_max_kg: { gte: query.quantite_kg },
      },
      include: {
        users: { select: { id: true, full_name: true, rating: true } },
      },
    });

    const quotes: TransportQuote[] = candidates.map((route) => {
      const calc = route.tarif_kg.toNumber() * query.quantite_kg;
      const min = route.tarif_minimum.toNumber();
      const total = Math.max(calc, min);
      return {
        route_id: route.id,
        transporter_id: route.transporter_id,
        transporter_name: route.users.full_name,
        rating: route.users.rating.toNumber(),
        tarif_total: Math.round(total * 100) / 100,
        delai_typique: route.delai_typique,
      };
    });

    return quotes.sort((a, b) => a.tarif_total - b.tarif_total);
  }

  // ===================================================================
  //  SHIPMENTS
  // ===================================================================

  /**
   * Crée un shipment au moment de la commande. Appelé en interne par
   * OrdersService (pas exposé en route HTTP).
   *
   * Le shipment est créé avec transporter_id = null, status = REQUESTED.
   * Une notif sera envoyée à tous les TRANSPORTERS dont une route matche.
   */
  async createShipmentForOrder(params: {
    commande_id: string;
    origin_zone: string;
    destination_zone: string;
    pickup_address: string;
    delivery_address: string;
    quantite_kg: number;
    prix_final: number;
  }) {
    const shipment = await this.prisma.shipments.create({
      data: {
        commande_id: params.commande_id,
        origin_zone: params.origin_zone,
        destination_zone: params.destination_zone,
        pickup_address: params.pickup_address,
        delivery_address: params.delivery_address,
        quantite_kg: params.quantite_kg,
        prix_final: params.prix_final,
        prix_devis: params.prix_final,
        status: shipment_status.REQUESTED,
      },
    });
    this.logger.log(
      `Shipment created ${shipment.id} for order ${params.commande_id} (${params.origin_zone}→${params.destination_zone})`,
    );
    // Notifie les transporteurs éligibles (best effort, hors transaction).
    void this.notifyEligibleTransporters(shipment.id);
    return shipment;
  }

  /**
   * Liste les missions disponibles qui matchent l'une des routes
   * actives du TRANSPORTER. → "Missions dans votre zone".
   */
  async getAvailableMissions(transporterId: string) {
    const routes = await this.prisma.transporter_routes.findMany({
      where: { transporter_id: transporterId, is_active: true },
      select: { origin_zone: true, destination_zone: true, capacite_max_kg: true },
    });
    if (routes.length === 0) return [];

    const conditions = routes.map((r) => ({
      origin_zone: r.origin_zone,
      destination_zone: r.destination_zone,
      quantite_kg: { lte: r.capacite_max_kg },
    }));

    return this.prisma.shipments.findMany({
      where: {
        status: shipment_status.REQUESTED,
        transporter_id: null,
        OR: conditions,
      },
      include: {
        commandes_vente: {
          select: { reference: true, montant_total: true, buyer_id: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Le TRANSPORTER accepte une mission disponible. Premier arrivé,
   * premier servi.
   *
   * Effets :
   *   • shipment.transporter_id = transporterId, status = ACCEPTED
   *   • escrow TRANSPORT.beneficiary_id = transporterId (via Finance)
   *   • notif au buyer
   */
  async acceptShipment(transporterId: string, shipmentId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE : verrouille le shipment pour empêcher 2
      // transporters d'accepter simultanément. Le 2e bloquera jusqu'au
      // commit du 1er, puis verra transporter_id déjà set → conflit.
      const locked = await tx.$queryRaw<
        {
          id: string;
          transporter_id: string | null;
          status: string;
          origin_zone: string | null;
          destination_zone: string | null;
          quantite_kg: any;
        }[]
      >`SELECT id, transporter_id, status, origin_zone, destination_zone, quantite_kg
          FROM shipments
          WHERE id = ${shipmentId}::uuid
          FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Mission introuvable.');
      const shipment = locked[0];

      if (shipment.transporter_id) {
        throw new ConflictException("Mission déjà acceptée par un autre transporteur.");
      }
      if (shipment.status !== shipment_status.REQUESTED) {
        throw new BadRequestException(`Mission au statut ${shipment.status}.`);
      }

      // Vérifie que le transporter a une route compatible (anti-fraude).
      const routeMatch = await tx.transporter_routes.findFirst({
        where: {
          transporter_id: transporterId,
          origin_zone: shipment.origin_zone ?? '',
          destination_zone: shipment.destination_zone ?? '',
          is_active: true,
          capacite_max_kg: { gte: shipment.quantite_kg ?? 0 },
        },
      });
      if (!routeMatch) {
        throw new ForbiddenException(
          "Aucune route active correspondante. Déclarez-en une d'abord.",
        );
      }

      const result = await tx.shipments.update({
        where: { id: shipmentId },
        data: {
          transporter_id: transporterId,
          status: shipment_status.ACCEPTED,
        },
      });
      this.logger.log(`Shipment ${shipmentId} accepted by ${transporterId}`);
      return result;
    });

    // Hors transaction : affecte escrow + notifie buyer.
    await this.finance.assignTransportEscrowBeneficiary(
      updated.commande_id,
      transporterId,
    );
    await this.safeNotify(updated.commande_id, {
      target: 'buyer',
      titre: 'Votre commande va être livrée 🚚',
      body: 'Un transporteur a accepté votre livraison.',
    });

    return updated;
  }

  async startLoading(transporterId: string, shipmentId: string, dto: StartLoadingDto) {
    return this.transitionShipment(transporterId, shipmentId, ShipmentStatus.LOADING, {
      position: dto.pickup_position,
      note: 'Chargement chez le vendeur',
    });
  }

  async markInTransit(
    transporterId: string,
    shipmentId: string,
    dto: TrackPositionDto,
  ) {
    return this.transitionShipment(
      transporterId,
      shipmentId,
      dto.status ?? ShipmentStatus.IN_TRANSIT,
      { position: dto.position, note: dto.note },
    );
  }

  /**
   * Le TRANSPORTER marque la mission livrée. Photo preuve obligatoire.
   * Bascule la commande en DELIVERED — le buyer pourra alors confirmer
   * et déclencher la libération des deux escrows.
   */
  async markDelivered(
    transporterId: string,
    shipmentId: string,
    dto: MarkDeliveredDto,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const shipment = await tx.shipments.findUnique({
        where: { id: shipmentId },
      });
      if (!shipment) throw new NotFoundException('Mission introuvable.');
      if (shipment.transporter_id !== transporterId) {
        throw new ForbiddenException('Mission non rattachée à votre compte.');
      }
      const current = shipment.status as unknown as ShipmentStatus;
      if (!SHIPMENT_TRANSITIONS[current].includes(ShipmentStatus.DELIVERED)) {
        throw new BadRequestException(
          `Transition impossible ${current} → DELIVERED.`,
        );
      }

      const result = await tx.shipments.update({
        where: { id: shipmentId },
        data: {
          status: shipment_status.DELIVERED,
          photo_preuve_url: dto.photo_preuve_url,
          delivered_at: new Date(),
          notes: dto.note ?? shipment.notes,
        },
      });

      if (dto.delivery_position) {
        await tx.$executeRaw`
          INSERT INTO shipment_tracking (shipment_id, location, status, note)
          VALUES (
            ${shipmentId}::uuid,
            ST_SetSRID(ST_MakePoint(${dto.delivery_position.lng}, ${dto.delivery_position.lat}), 4326),
            ${shipment_status.DELIVERED}::shipment_status,
            ${dto.note ?? 'Livraison confirmée'}
          );
        `;
      }

      await tx.commandes_vente.update({
        where: { id: result.commande_id },
        data: { status: 'DELIVERED' },
      });

      return result;
    });

    await this.safeNotify(updated.commande_id, {
      target: 'buyer',
      titre: 'Livraison effectuée ✅',
      body: 'Veuillez confirmer la réception pour libérer les fonds.',
    });
    return updated;
  }

  async cancelShipment(transporterId: string, shipmentId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Lock atomique : empêche un release escrow concurrent.
      const locked = await tx.$queryRaw<
        { id: string; status: string; commande_id: string; transporter_id: string | null }[]
      >`SELECT id, status, commande_id, transporter_id
          FROM shipments
          WHERE id = ${shipmentId}::uuid AND transporter_id = ${transporterId}::uuid
          FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Mission introuvable.');
      const shipment = locked[0];

      const current = shipment.status as unknown as ShipmentStatus;
      if (!SHIPMENT_TRANSITIONS[current].includes(ShipmentStatus.CANCELLED)) {
        throw new BadRequestException(`Annulation impossible depuis ${current}.`);
      }

      // Reset shipment.transporter_id pour que la mission redevienne
      // disponible aux autres transporters.
      const result = await tx.shipments.update({
        where: { id: shipmentId },
        data: { status: shipment_status.CANCELLED, transporter_id: null },
      });

      // CRITIQUE : reset escrow TRANSPORT.beneficiary_id sinon, à la
      // libération de l'escrow, l'argent partirait vers un transporter
      // qui n'a rien livré.
      await tx.escrow_conditions.updateMany({
        where: {
          commande_id: shipment.commande_id,
          kind: 'TRANSPORT',
          beneficiary_id: transporterId,
          status: 'LOCKED',
        },
        data: { beneficiary_id: null },
      });

      this.logger.warn(
        `Shipment ${shipmentId} cancelled by ${transporterId} — escrow TRANSPORT beneficiary cleared`,
      );
      return result;
    });
  }

  // ===================================================================
  //  CLEANUP : shipments REQUESTED orphelins
  //  ---------------------------------------------------------------------
  //  Si une commande a un shipment REQUESTED mais qu'aucun transporter
  //  n'accepte dans X heures, on annule le shipment et on libère le
  //  buyer (refund de l'escrow TRANSPORT).
  // ===================================================================

  async cleanupOrphanShipments(maxAgeHours = 48): Promise<{ cancelled: number }> {
    const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const orphans = await this.prisma.shipments.findMany({
      where: {
        status: shipment_status.REQUESTED,
        transporter_id: null,
        created_at: { lt: threshold },
      },
      select: { id: true, commande_id: true },
    });
    for (const s of orphans) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.shipments.update({
            where: { id: s.id },
            data: { status: shipment_status.CANCELLED },
          });
          // Refund de l'escrow TRANSPORT (jamais affecté à un transporter)
          await tx.escrow_conditions.updateMany({
            where: { commande_id: s.commande_id, kind: 'TRANSPORT', status: 'LOCKED' },
            data: { status: 'REFUNDED', released_at: new Date(), release_reason: 'NO_TRANSPORTER_AVAILABLE' },
          });
        });
        this.logger.warn(
          `Shipment orphelin annulé: ${s.id} (>${maxAgeHours}h sans transporteur)`,
        );
      } catch (e: any) {
        this.logger.error(`Cleanup shipment ${s.id} KO: ${e?.message}`);
      }
    }
    return { cancelled: orphans.length };
  }

  // ===================================================================
  //  TRACKING
  // ===================================================================

  /**
   * Le BUYER (ou le SELLER ou le TRANSPORTER lui-même) consulte
   * l'historique GPS du shipment. Vérifie l'appartenance à la commande.
   */
  async getTracking(userId: string, shipmentId: string) {
    const shipment = await this.prisma.shipments.findUnique({
      where: { id: shipmentId },
      include: { commandes_vente: true },
    });
    if (!shipment) throw new NotFoundException('Mission introuvable.');
    const parties = new Set([
      shipment.commandes_vente.buyer_id,
      shipment.commandes_vente.seller_id,
      shipment.transporter_id,
    ]);
    if (!parties.has(userId)) {
      throw new ForbiddenException('Accès refusé.');
    }
    return this.prisma.shipment_tracking.findMany({
      where: { shipment_id: shipmentId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  // ===================================================================
  //  QR PICKUP TOKEN — Chantier 1 (auto-release escrow PRODUCT)
  //  ---------------------------------------------------------------------
  //  Génération côté producteur d'un token HMAC court (TTL 15 min) à
  //  encoder en QR. Le transporteur le scanne pour prouver sa présence
  //  physique au point d'enlèvement, ce qui :
  //    1) bascule le shipment en LOADING
  //    2) auto-libère l'escrow PRODUCT du producteur (cash flow immédiat)
  //    3) crée un event PICKUP_QR_SCANNED dans traceability_events
  //  Sécurité : signature HMAC-SHA256, expiration stricte, vérification
  //  GPS < 500 m, comparaison timing-safe pour bloquer les forgeries.
  // ===================================================================

  /**
   * GET /logistics/shipments/:id/qr-token — réservé au FARMER (seller).
   * Régénère le token à chaque appel (l'ancien devient invalide).
   */
  async generatePickupQrToken(userId: string, shipmentId: string) {
    // 1. Charger shipment + commande pour vérifier ownership
    const shipment = await this.prisma.shipments.findUnique({
      where: { id: shipmentId },
      include: { commandes_vente: true },
    });
    if (!shipment) throw new NotFoundException('Shipment introuvable.');

    // 2. Seul le seller (producteur) du shipment peut générer le QR
    if (shipment.commandes_vente.seller_id !== userId) {
      throw new ForbiddenException("Vous n'êtes pas le vendeur de cette commande.");
    }

    // 3. Le QR n'a de sens qu'entre ACCEPTED et LOADING
    if (shipment.status !== shipment_status.ACCEPTED) {
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
    const secret = this.config.get<string>('PICKUP_QR_SECRET');
    if (!secret || secret.length < 32) {
      throw new InternalServerErrorException('PICKUP_QR_SECRET non configuré.');
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

  /**
   * POST /logistics/shipments/:id/scan-pickup — réservé au TRANSPORTER.
   * Validation cryptographique du token AVANT toute écriture DB pour
   * rejeter les forgeries sans coût en lecture.
   */
  async scanPickup(
    transporterId: string,
    shipmentId: string,
    dto: ScanPickupDto,
  ) {
    // 1. Vérification cryptographique du token AVANT toute écriture DB
    const parts = dto.token.split('.');
    if (parts.length !== 3) {
      throw new BadRequestException('Token mal formé.');
    }
    const [shipShort, expUnixStr, sig] = parts;
    const secret = this.config.get<string>('PICKUP_QR_SECRET');
    if (!secret || secret.length < 32) {
      throw new InternalServerErrorException('PICKUP_QR_SECRET non configuré.');
    }
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${shipShort}.${expUnixStr}`)
      .digest('hex')
      .slice(0, 16);
    // timingSafeEqual exige que les deux buffers aient la même longueur ;
    // sinon il throw. On compare donc d'abord la taille pour éviter une
    // exception (et fuites de timing).
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new BadRequestException('Signature QR invalide.');
    }
    const expUnix = parseInt(expUnixStr, 10);
    if (Number.isNaN(expUnix) || expUnix * 1000 < Date.now()) {
      throw new BadRequestException(
        'QR expiré. Demandez au producteur de regénérer.',
      );
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

    // 3. Idempotence : si déjà scanné, retourner l'état actuel sans rejouer
    if (shipment.pickup_scanned_at) {
      return {
        shipment,
        escrow_released: { product: { already_done: true } },
      };
    }

    // 4. Anti-fraude GPS : transporteur doit être à < 500 m du pickup
    //    On utilise PostGIS ST_Distance en géographie (mètres directs).
    //    NB : pickup_location est `Unsupported("geography")` côté Prisma —
    //    on ne peut pas le lire via le client typé, on passe donc par raw.
    //    Si pickup_location est NULL, ST_Distance retourne NULL → skip.
    const distRows = await this.prisma.$queryRaw<{ d: number | null }[]>`
      SELECT ST_Distance(
        pickup_location::geography,
        ST_SetSRID(ST_MakePoint(${dto.scan_position.lng}, ${dto.scan_position.lat}), 4326)::geography
      ) AS d
      FROM shipments
      WHERE id = ${shipmentId}::uuid`;
    const dist = distRows[0]?.d != null ? Number(distRows[0].d) : null;
    if (dist != null && dist > 500) {
      throw new BadRequestException(
        `Vous êtes à ${Math.round(dist)} m du point de retrait (max: 500 m).`,
      );
    }

    // 5. Atomique : bascule shipment + tracking GPS + traceability event
    const result = await this.prisma.$transaction(async (tx) => {
      // a) Marquer scanné + bascule LOADING
      const updated = await tx.shipments.update({
        where: { id: shipmentId },
        data: {
          status: shipment_status.LOADING,
          pickup_scanned_at: new Date(),
          pickup_scanned_by: transporterId,
          // On laisse pickup_qr_token tel quel pour l'audit
        },
      });

      // b) Insérer un tracking point GPS
      await tx.$executeRaw`
        INSERT INTO shipment_tracking (shipment_id, location, status, note)
        VALUES (
          ${shipmentId}::uuid,
          ST_SetSRID(ST_MakePoint(${dto.scan_position.lng}, ${dto.scan_position.lat}), 4326),
          ${shipment_status.LOADING}::shipment_status,
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

    // 6. Hors transaction : libérer l'escrow PRODUCT via FinanceService.
    //    releaseEscrow ouvre sa propre TX et est idempotent (skip si plus
    //    de LOCKED). Si la release échoue (escrow déjà libéré par admin),
    //    on log mais on ne casse pas le scan : le shipment est en LOADING.
    let releasePayload: unknown = null;
    try {
      releasePayload = await this.finance.releaseEscrow(
        shipment.commande_id,
        transporterId,
        EscrowKind.PRODUCT,
        'AUTO_PICKUP_SCAN',
      );
      // Flag de reporting : distingue les release auto-pickup des manuelles
      await this.prisma.escrow_conditions.updateMany({
        where: {
          commande_id: shipment.commande_id,
          kind: EscrowKind.PRODUCT,
          released_by: transporterId,
          release_reason: 'AUTO_PICKUP_SCAN',
        },
        data: { auto_released_on_pickup: true },
      });
    } catch (e: any) {
      this.logger.warn(
        `Release PRODUCT échoué après scan ${shipmentId}: ${e?.message ?? e}`,
      );
    }

    // 7. Notifier le producteur (best-effort)
    try {
      await this.notifications.create({
        user_id: shipment.commandes_vente.seller_id,
        type: NotificationType.PAYMENT,
        titre: 'Marchandise enlevée — argent disponible',
        body: "Le transporteur a confirmé l'enlèvement. Votre paiement est crédité.",
        shipment_id: shipmentId,
        commande_id: shipment.commande_id,
      });
    } catch (err) {
      this.logger.warn(
        `Notification PAYMENT_RELEASED failed for ${shipmentId}: ${(err as Error).message}`,
      );
    }

    return { shipment: result, escrow_released: releasePayload };
  }

  // ===================================================================
  //  HELPERS PRIVÉS
  // ===================================================================

  private async transitionShipment(
    transporterId: string,
    shipmentId: string,
    targetStatus: ShipmentStatus,
    extras: { position?: { lat: number; lng: number }; note?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const shipment = await tx.shipments.findUnique({
        where: { id: shipmentId },
      });
      if (!shipment) throw new NotFoundException('Mission introuvable.');
      if (shipment.transporter_id !== transporterId) {
        throw new ForbiddenException('Mission non rattachée à votre compte.');
      }
      const current = shipment.status as unknown as ShipmentStatus;
      if (!SHIPMENT_TRANSITIONS[current].includes(targetStatus)) {
        throw new BadRequestException(
          `Transition impossible ${current} → ${targetStatus}.`,
        );
      }

      const updated = await tx.shipments.update({
        where: { id: shipmentId },
        data: { status: targetStatus as unknown as shipment_status },
      });

      if (extras.position) {
        await tx.$executeRaw`
          INSERT INTO shipment_tracking (shipment_id, location, status, note)
          VALUES (
            ${shipmentId}::uuid,
            ST_SetSRID(ST_MakePoint(${extras.position.lng}, ${extras.position.lat}), 4326),
            ${targetStatus as unknown as shipment_status}::shipment_status,
            ${extras.note ?? null}
          );
        `;
      }

      return updated;
    });
  }

  /**
   * Best-effort : alerte les transporteurs dont une route matche.
   */
  private async notifyEligibleTransporters(shipmentId: string): Promise<void> {
    try {
      const shipment = await this.prisma.shipments.findUnique({
        where: { id: shipmentId },
      });
      if (!shipment || !shipment.origin_zone || !shipment.destination_zone) return;

      const routes = await this.prisma.transporter_routes.findMany({
        where: {
          origin_zone: shipment.origin_zone,
          destination_zone: shipment.destination_zone,
          is_active: true,
          capacite_max_kg: { gte: shipment.quantite_kg ?? 0 },
        },
        select: { transporter_id: true },
      });

      const seen = new Set<string>();
      for (const route of routes) {
        if (seen.has(route.transporter_id)) continue;
        seen.add(route.transporter_id);
        await this.notifications
          .create({
            user_id: route.transporter_id,
            type: 'SYSTEM',
            titre: 'Nouvelle mission disponible 🚚',
            body: `${shipment.origin_zone} → ${shipment.destination_zone}, ${shipment.quantite_kg}kg`,
          } as any)
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(
        `notifyEligibleTransporters failed for ${shipmentId}: ${(err as Error).message}`,
      );
    }
  }

  private async safeNotify(
    commandeId: string,
    payload: { target: 'buyer' | 'seller'; titre: string; body: string },
  ): Promise<void> {
    try {
      const cmd = await this.prisma.commandes_vente.findUnique({
        where: { id: commandeId },
        select: { buyer_id: true, seller_id: true },
      });
      if (!cmd) return;
      const userId = payload.target === 'buyer' ? cmd.buyer_id : cmd.seller_id;
      await this.notifications.create({
        user_id: userId,
        type: 'SYSTEM',
        titre: payload.titre,
        body: payload.body,
        commande_id: commandeId,
      } as any);
    } catch (err) {
      this.logger.warn(`Notification failed: ${(err as Error).message}`);
    }
  }
}
