// =====================================================================
//  GUARDS : JwtAuthGuard + RolesGuard
//  ---------------------------------------------------------------------
//  Deux gardes complémentaires utilisés dans toute l'application pour
//  protéger les routes :
//
//   1. JwtAuthGuard : exige un Bearer JWT valide. Décodé, le payload est
//                     injecté dans `request.user` → récupérable via le
//                     décorateur `@CurrentUser()` (cf. modules/shared).
//
//   2. RolesGuard   : à utiliser EN COMPLÉMENT de JwtAuthGuard. Vérifie
//                     que `request.user.role` figure dans la liste des
//                     rôles autorisés (déclarés via `@Roles(...)`).
//
//  Exemples d'usage dans un controller :
//
//     // Route protégée, n'importe quel utilisateur authentifié
//     @UseGuards(JwtAuthGuard)
//     @Get('me') ...
//
//     // Route admin uniquement
//     @UseGuards(JwtAuthGuard, RolesGuard)
//     @Roles('ADMIN')
//     @Delete('users/:id') ...
//
//     // Route coopérative OU admin
//     @UseGuards(JwtAuthGuard, RolesGuard)
//     @Roles('COOPERATIVE', 'ADMIN')
//     @Post('publications/coop') ...
// =====================================================================

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Protège une route : exige un header `Authorization: Bearer <jwt>`
 * valide. En cas de succès, attache le payload décodé à `request.user`.
 * Renvoie 401 sinon (avec un message clair).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException("Token JWT manquant. Connectez-vous d'abord.");
    }

    try {
      // verifyAsync utilise le secret défini dans JwtModule (cf. auth.module.ts).
      // Il vérifie aussi l'expiration : un token expiré sera rejeté ici.
      const payload = await this.jwtService.verifyAsync(token);
      (request as Request & { user: unknown }).user = payload;
    } catch {
      // Toute erreur de vérif (signature invalide, expiré, mal formé)
      // se traduit par un 401 générique — on ne révèle pas la cause.
      throw new UnauthorizedException(
        'Token JWT invalide ou expiré. Reconnectez-vous.',
      );
    }

    return true;
  }

  /**
   * Récupère le token brut depuis le header `Authorization`. Tolère la
   * casse sur le schéma "Bearer" (Bearer, bearer, BEARER…) → robustesse.
   */
  private extractTokenFromHeader(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [type, token] = header.split(' ');
    if (!type || !token) return undefined;
    return type.toLowerCase() === 'bearer' ? token : undefined;
  }
}

/**
 * Variante "best-effort" de JwtAuthGuard : si un Bearer token valide
 * est présent, peuple `request.user` ; sinon laisse passer en anonyme
 * (request.user reste undefined). Utilisé pour les routes PUBLIQUES qui
 * doivent quand même connaître l'identité du viewer si elle est dispo
 * (ex: data masking selon rôle).
 *
 * NE PAS confondre avec JwtAuthGuard qui rejette en 401 si pas de token.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header) return true; // pas de header → anonyme, on laisse passer

    const [type, token] = header.split(' ');
    if (!type || !token || type.toLowerCase() !== 'bearer') return true;

    try {
      const payload = await this.jwtService.verifyAsync(token);
      (request as Request & { user: unknown }).user = payload;
    } catch {
      // Token invalide/expiré : on traite comme anonyme (pas de 401).
      // Ça évite de casser une route publique parce qu'un client a un
      // vieux token traîné en cache.
    }
    return true;
  }
}

// =====================================================================
//  Décorateur @Roles(...)
//  ---------------------------------------------------------------------
//  Déclare la liste des rôles autorisés pour une route ou un controller.
//  Utilisé en lecture par RolesGuard via Reflector.
// =====================================================================
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Vérifie que l'utilisateur connecté possède l'un des rôles requis par
 * la route. À utiliser APRÈS JwtAuthGuard dans la chaîne `@UseGuards`,
 * sinon `request.user` ne sera pas peuplé.
 *
 * Si aucun rôle n'est exigé via `@Roles(...)`, ce guard laisse passer.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // On lit la liste de rôles déclarée par @Roles(...) sur la méthode
    // OU sur la classe (override de classe → méthode).
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user?.role) {
      // Sécurité : on refuse explicitement si JwtAuthGuard n'a pas été
      // mis avant ce guard (oubli de configuration côté controller).
      throw new UnauthorizedException('Authentification requise pour cette route.');
    }
    return requiredRoles.includes(user.role);
  }
}
