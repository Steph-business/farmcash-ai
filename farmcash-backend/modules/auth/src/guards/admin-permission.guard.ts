// =====================================================================
//  Décorateur @AdminPermission(...) + AdminPermissionGuard
//  ---------------------------------------------------------------------
//  Ajoute un niveau de contrôle FIN sur les routes ADMIN : au lieu de
//  juste vérifier `role=ADMIN`, on exige que l'admin dispose d'une (ou
//  plusieurs) permissions parmi :
//     • peut_valider_kyc
//     • peut_gerer_finance
//     • peut_gerer_users
//     • peut_publier_news
//
//  Règles d'or (ordre d'évaluation) :
//   1. Aucune permission requise sur la route        → laisse passer
//   2. L'utilisateur connecté n'est PAS ADMIN        → laisse passer
//      (routes mixtes type @Roles('COOPERATIVE','ADMIN') : on n'applique
//      les permissions admin QUE quand l'appelant est admin)
//   3. niveau == SUPER_ADMIN                          → bypass total
//   4. AU MOINS une des permissions requises = true  → autorisé
//   5. Sinon                                          → 403
//
//  À placer APRÈS JwtAuthGuard et RolesGuard dans la chaîne @UseGuards.
//
//  Usage :
//    @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
//    @Roles('ADMIN')
//    @AdminPermission('peut_gerer_users')
//    @Post('users/:id/deactivate')
//    deactivate(...) { ... }
// =====================================================================

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@farmcash/database';

/**
 * Liste des flags `peut_*` de la table `admin_profiles`.
 * Centralisé ici pour que le typing soit cohérent partout
 * (décorateur, guard, DTO).
 */
export type AdminPermissionFlag =
  | 'peut_valider_kyc'
  | 'peut_gerer_finance'
  | 'peut_gerer_users'
  | 'peut_publier_news';

export const ADMIN_PERMISSION_KEY = 'admin_permission';

/**
 * Déclare la liste des permissions ADMIN qu'au moins une doit être à
 * `true` pour passer le guard. La liste est en OR logique (any-of).
 */
export const AdminPermission = (...perms: AdminPermissionFlag[]) =>
  SetMetadata(ADMIN_PERMISSION_KEY, perms);

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AdminPermissionFlag[]>(
      ADMIN_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // 1. Aucune permission requise → pas de check
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();

    // 2. Pas ADMIN → on laisse passer (le RolesGuard a déjà filtré le rôle).
    //    Cas typique : route @Roles('COOPERATIVE','ADMIN') — quand l'appelant
    //    est COOPERATIVE on n'a aucune permission admin à vérifier.
    if (!user || user.role !== 'ADMIN') return true;

    // 3. Charge le profil admin (un seul par user, FK 1-1)
    const profile = await this.prisma.admin_profiles.findUnique({
      where: { user_id: user.sub },
      select: {
        niveau: true,
        peut_valider_kyc: true,
        peut_gerer_finance: true,
        peut_gerer_users: true,
        peut_publier_news: true,
      },
    });

    if (!profile) {
      // Cas anormal : un user role=ADMIN sans admin_profiles. Soit
      // l'inscription est passée avant la migration backfill, soit on
      // a un compte cassé. On refuse pour ne PAS donner d'accès par défaut.
      throw new ForbiddenException(
        'Aucun profil admin associé à ce compte (contactez un SUPER_ADMIN).',
      );
    }

    // 4. SUPER_ADMIN bypass : a toutes les permissions par définition.
    if (profile.niveau === 'SUPER_ADMIN') return true;

    // 5. OR logique sur les permissions demandées
    const granted = required.some((perm) => profile[perm] === true);
    if (!granted) {
      throw new ForbiddenException(
        `Permission admin insuffisante. Au moins une parmi : ${required.join(', ')}.`,
      );
    }

    return true;
  }
}
