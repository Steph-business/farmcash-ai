import { SetMetadata } from '@nestjs/common';

/**
 * Type des transformations supportées par le MaskingInterceptor.
 *  - 'phone'   → tronque le numéro (`+225 ** ** ** 78`)
 *  - 'name'    → prénom + initiale du nom (`Sylvain K.`)
 *  - 'geo'     → arrondit lat/lng à 2 décimales (~1 km)
 *  - 'address' → supprime l'adresse précise (rue / numéro) — ne garde que la ville
 */
export type MaskKind = 'phone' | 'name' | 'geo' | 'address';

/**
 * Clé metadata du décorateur @MaskFields() — lue par MaskingInterceptor.
 */
export const MASK_FIELDS_KEY = 'mask_fields';

/**
 * Déclare les champs sensibles à masquer dans la réponse d'un handler.
 * Le mapping suit une notation par chemin :
 *
 *   @MaskFields({
 *     'users.phone': 'phone',
 *     'users.full_name': 'name',
 *     'users.coordinates': 'geo',
 *   })
 *   @Get('annonces/vente/:id')
 *   getAnnonceVente(...) {}
 *
 * Pour les réponses sous forme de liste ou enveloppées
 * (`{ items: [...] }`, `{ data: [...] }`, `[...]`), le interceptor traverse
 * automatiquement les arrays et applique le masking à chaque entrée.
 */
export const MaskFields = (
  cfg: Record<string, MaskKind>,
): MethodDecorator & ClassDecorator => SetMetadata(MASK_FIELDS_KEY, cfg);
