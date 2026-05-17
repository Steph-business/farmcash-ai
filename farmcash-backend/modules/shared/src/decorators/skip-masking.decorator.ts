import { SetMetadata } from '@nestjs/common';

/**
 * Clé metadata du décorateur @SkipMasking() — lue par MaskingInterceptor.
 */
export const SKIP_MASKING_KEY = 'skip_masking';

/**
 * Bypass complet du MaskingInterceptor sur un handler ou un controller.
 * À utiliser pour les routes ADMIN d'audit où les PII clair sont nécessaires
 * (export RGPD, fiche litige, etc.).
 *
 * Usage :
 *   @SkipMasking()
 *   @Get('admin/users/:id/full')
 *   getUserFull(@Param('id') id: string) { ... }
 */
export const SkipMasking = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_MASKING_KEY, true);
