import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalise un numéro vers le format E.164 (+225...).
 * Retourne null si le numéro est invalide.
 *
 * Usage : à utiliser dans les services (pas dans les DTOs) pour
 * stocker un format canonique en DB indépendamment de la saisie user.
 */
export const normalizePhone = (raw: string, defaultCountry?: string): string | null => {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry as any);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
};
