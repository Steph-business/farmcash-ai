import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  sub: string;
  role: string;
  phone: string;
  cooperative_id: string | null;
  iat?: number;
  exp?: number;
}

/**
 * Injecte l'utilisateur authentifié (extrait du JWT par JwtAuthGuard).
 * Usage : `monProfil(@CurrentUser() user: AuthenticatedUser)`.
 *
 * Si la route n'est pas protégée par JwtAuthGuard, retourne `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
