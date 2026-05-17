import { createHash } from 'node:crypto';

/**
 * Hash déterministe SHA-256 pour les tokens à entropie élevée
 * (refresh_token = 64 bytes random). Bcrypt n'est pas adapté ici
 * car le sel aléatoire empêche la recherche par hash en DB.
 */
export const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');
