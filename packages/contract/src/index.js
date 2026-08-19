/**
 * Contrat d'API partagé.
 *
 * @spec docs/BACKLOG.md#SPK-17 · docs/DAT.md §23.3 (les types sont dérivés)
 *
 * Les types vivent dans `types.d.ts`, produits depuis l'OpenAPI de `sparkd`.
 * Ce module n'expose que ce qu'un runtime JavaScript peut utiliser : la liste
 * des chemins, pour qu'un appel vers une route inexistante échoue à l'écriture
 * plutôt qu'en production.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICI = dirname(fileURLToPath(import.meta.url));

export const OPENAPI_PATH = join(ICI, '..', 'openapi', 'sparkd.json');

export function loadSchema() {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
}

/** Chemins déclarés par le runtime, triés. */
export function paths() {
  return Object.keys(loadSchema().paths).sort();
}

/** Méthodes acceptées par un chemin, ou `null` s'il n'existe pas. */
export function methods(path) {
  const declare = loadSchema().paths[path];
  if (!declare) return null;
  return Object.keys(declare)
    .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
    .map((m) => m.toUpperCase())
    .sort();
}
