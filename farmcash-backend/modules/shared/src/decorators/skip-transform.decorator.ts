import { SetMetadata } from '@nestjs/common';

export const SKIP_TRANSFORM_KEY = 'skipTransform';

/**
 * Bypass le TransformInterceptor sur un handler ou un controller.
 * Indispensable pour : SSE, streams binaires, file downloads, redirects.
 */
export const SkipTransform = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_TRANSFORM_KEY, true);
