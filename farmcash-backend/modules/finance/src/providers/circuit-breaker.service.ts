// =====================================================================
//  CircuitBreaker
//  ---------------------------------------------------------------------
//  Pattern Hystrix simplifié, par provider :
//   • CLOSED      : tout passe (état normal)
//   • OPEN        : tout refusé pendant `cooldownMs` après N échecs
//   • HALF_OPEN   : passe une seule requête de test après cooldown
//
//  État stocké en DB (provider_circuit_state) pour survie au restart.
//
//  Seuils par défaut :
//   • threshold = 5 échecs consécutifs → OPEN
//   • cooldownMs = 30s → bascule HALF_OPEN
//   • Si la requête HALF_OPEN passe → CLOSED. Sinon → OPEN à nouveau.
// =====================================================================

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';

const THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * À appeler avant chaque requête provider. Si le circuit est OPEN,
   * lève ServiceUnavailableException. Si HALF_OPEN et déjà testé,
   * idem.
   */
  async assertAvailable(provider: string): Promise<void> {
    const state = await this.prisma.provider_circuit_state.findUnique({
      where: { provider },
    });
    if (!state) return; // CLOSED par défaut

    if (state.state === 'OPEN') {
      const cooldownElapsed =
        state.opened_at && Date.now() - state.opened_at.getTime() > COOLDOWN_MS;
      if (cooldownElapsed) {
        // Bascule en HALF_OPEN : autorise UN essai
        await this.prisma.provider_circuit_state.update({
          where: { provider },
          data: { state: 'HALF_OPEN' },
        });
        return;
      }
      throw new ServiceUnavailableException(
        `Provider ${provider} indisponible (circuit OPEN). Réessayez plus tard.`,
      );
    }
  }

  /** À appeler après une requête réussie. */
  async recordSuccess(provider: string): Promise<void> {
    await this.prisma.provider_circuit_state.upsert({
      where: { provider },
      create: { provider, state: 'CLOSED', failure_count: 0 },
      update: {
        state: 'CLOSED',
        failure_count: 0,
        last_failure_at: null,
        opened_at: null,
      },
    });
  }

  /** À appeler après une requête échouée. */
  async recordFailure(provider: string): Promise<void> {
    const state = await this.prisma.provider_circuit_state.upsert({
      where: { provider },
      create: {
        provider,
        state: 'CLOSED',
        failure_count: 1,
        last_failure_at: new Date(),
      },
      update: {
        failure_count: { increment: 1 },
        last_failure_at: new Date(),
      },
    });

    if (state.failure_count >= THRESHOLD && state.state !== 'OPEN') {
      await this.prisma.provider_circuit_state.update({
        where: { provider },
        data: { state: 'OPEN', opened_at: new Date() },
      });
      this.logger.warn(
        `Circuit OPEN pour ${provider} (${state.failure_count} échecs consécutifs)`,
      );
    }
  }

  /** Lecture de l'état (pour dashboard / health check). */
  async getState(provider: string) {
    return this.prisma.provider_circuit_state.findUnique({
      where: { provider },
    });
  }
}
