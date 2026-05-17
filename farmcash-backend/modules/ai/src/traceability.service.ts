// =====================================================================
//  SERVICE : TraceabilityService
//  ---------------------------------------------------------------------
//  Suivi du parcours complet d'un lot (du champ au consommateur).
//
//  USAGE PUBLIC :
//   • GET /ai/traceability/:lotId → lecture libre (accessible par scan QR
//     sans authentification : le consommateur final peut vérifier
//     l'origine du produit qu'il achète au marché).
//
//  USAGE INTERNE (DI) :
//   • Les autres modules appellent `addEvent(lotId, actorId, dto)`
//     à chaque étape métier (récolte par farmer, livraison par
//     transporter, etc.). Pas de route HTTP publique pour la création.
//
//  Le champ `blockchain_tx` reste `null` en MVP. Quand on branchera
//  Polygon, on enverra un hash de l'event vers la blockchain et on
//  stockera le tx hash ici pour preuve immuable.
// =====================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { CreateTraceabilityEventDto } from './dto/traceability.dto';

@Injectable()
export class TraceabilityService {
  private readonly logger = new Logger(TraceabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne toute la timeline d'un lot, triée chronologiquement
   * (la plus ancienne en premier — le consommateur lit le parcours).
   *
   * Inclut les infos du lot (produit, qualité, code) et de chaque acteur.
   *
   * Accessible publiquement (consultation par QR code). Pas
   * d'authentification requise → le consommateur final peut vérifier
   * la provenance sans avoir de compte.
   */
  async getLotHistory(lotId: string) {
    const lot = await this.prisma.lots.findUnique({
      where: { id: lotId },
      include: {
        produits_agricoles: { select: { nom: true, unite_mesure: true } },
      },
    });
    if (!lot) throw new NotFoundException('Lot introuvable.');

    const events = await this.prisma.traceability_events.findMany({
      where: { lot_id: lotId },
      orderBy: { created_at: 'asc' },
      include: {
        users: { select: { id: true, full_name: true, role: true } },
      },
    });

    return {
      lot: {
        id: lot.id,
        lot_code: lot.lot_code,
        produit: lot.produits_agricoles?.nom,
        qualite: lot.qualite,
        date_recolte: lot.date_recolte,
        quantite_kg: lot.quantite_kg,
        blockchain_tx: lot.blockchain_tx,
      },
      events: events.map((e) => ({
        id: e.id,
        type: e.event_type,
        date: e.created_at,
        actor: e.users
          ? {
              full_name: e.users.full_name,
              role: e.users.role,
            }
          : null,
        metadata: e.metadata,
        blockchain_tx: e.blockchain_tx,
        blockchain_net: e.blockchain_net,
      })),
    };
  }

  /**
   * Crée un événement sur la timeline d'un lot. Appelé en INTERNE par
   * les autres services (Marketplace, Orders, Logistics) — pas de
   * route HTTP publique.
   *
   * Si la position GPS est fournie, on l'enregistre avec PostGIS via
   * $queryRaw.
   */
  async addEvent(
    lotId: string,
    actorId: string,
    dto: CreateTraceabilityEventDto,
  ) {
    const lot = await this.prisma.lots.findUnique({
      where: { id: lotId },
      select: { id: true },
    });
    if (!lot) throw new NotFoundException('Lot introuvable.');

    const metadataJson = (dto.metadata ?? {}) as Prisma.InputJsonValue;

    if (dto.location) {
      const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO traceability_events (
          lot_id, event_type, actor_id, location, metadata
        ) VALUES (
          ${lotId}::uuid,
          ${dto.event_type},
          ${actorId}::uuid,
          ST_SetSRID(ST_MakePoint(${dto.location.lng}, ${dto.location.lat}), 4326),
          ${JSON.stringify(dto.metadata ?? {})}::jsonb
        ) RETURNING id;
      `;
      this.logger.log(
        `Traceability event ${dto.event_type} for lot ${lotId} (event=${inserted[0].id})`,
      );
      return this.prisma.traceability_events.findUnique({
        where: { id: inserted[0].id },
      });
    }

    const event = await this.prisma.traceability_events.create({
      data: {
        lot_id: lotId,
        actor_id: actorId,
        event_type: dto.event_type,
        metadata: metadataJson,
      },
    });
    this.logger.log(
      `Traceability event ${dto.event_type} for lot ${lotId} (event=${event.id})`,
    );
    return event;
  }
}
