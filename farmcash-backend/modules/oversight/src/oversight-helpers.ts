// =====================================================================
//  OversightHelpers
//  ---------------------------------------------------------------------
//  Fonctions partagées pour les dashboards :
//   • Conversion période → date pivot
//   • Bucketing par semaine pour les timelines
//   • Formatage standardisé des sorties
// =====================================================================

export type Period = '7d' | '30d' | '90d' | 'year';

/** Convertit un libellé en nombre de jours. */
export function periodToDays(period: Period | undefined): number {
  switch (period) {
    case '7d': return 7;
    case '90d': return 90;
    case 'year': return 365;
    case '30d':
    default:
      return 30;
  }
}

/** Date pivot : maintenant - period. */
export function periodSince(period: Period | undefined): Date {
  return new Date(Date.now() - periodToDays(period) * 24 * 60 * 60 * 1000);
}

/**
 * Bucket des items par semaine (ISO week start = lundi).
 * Retourne un Map<yyyy-Www, items[]> pour un agrégat ultérieur.
 */
export function bucketByWeek<T>(
  items: T[],
  dateGetter: (item: T) => Date | null | undefined,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const d = dateGetter(item);
    if (!d) continue;
    const key = isoWeekKey(d);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(item);
  }
  return buckets;
}

/** Clé semaine ISO "2026-W19" (lundi-dimanche). */
export function isoWeekKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // ISO week : jeudi de la semaine
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    );
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
