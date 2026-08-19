/**
 * Inventaire des serveurs administrés.
 *
 * @spec docs/BACKLOG.md#SPK-16 · docs/DAT.md §22.4 (aucun secret)
 *
 * Aucune clé, aucun mot de passe, aucune phrase de passe n'entre ici.
 * L'authentification appartient à la configuration SSH du poste : la dupliquer
 * doublerait les endroits où un secret peut fuir.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_PATH =
  process.env.SPARK_CONSOLE_STATE ?? join(homedir(), '.config', 'spark', 'servers.json');

/** Champs qu'un serveur peut porter. Tout le reste est écarté à l'écriture. */
const ALLOWED = ['name', 'host', 'user', 'port', 'remotePort'];

/** Motifs qui trahissent un secret glissé par erreur dans l'inventaire. */
const SECRET_HINT = /private[_-]?key|password|passphrase|secret|token|BEGIN [A-Z ]*PRIVATE KEY/i;

export class InventoryError extends Error {}

export function validate(server) {
  const nom = String(server?.name ?? '').trim();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(nom)) {
    throw new InventoryError(
      `Nom « ${server?.name} » invalide : minuscules, chiffres et tirets.`,
    );
  }
  const hote = String(server?.host ?? '').trim();
  if (!hote) throw new InventoryError(`Le serveur « ${nom} » n'a pas d'hôte.`);

  // On refuse plutôt que de filtrer en silence : un secret écrit ici l'a été
  // par erreur, et l'auteur doit le savoir pour le retirer d'où il l'a copié.
  for (const [cle, valeur] of Object.entries(server)) {
    if (SECRET_HINT.test(cle) || (typeof valeur === 'string' && SECRET_HINT.test(valeur))) {
      throw new InventoryError(
        `Le champ « ${cle} » ressemble à un secret. L'inventaire n'en contient ` +
          `jamais : l'authentification appartient à votre configuration SSH.`,
      );
    }
  }

  const port = Number(server.port ?? 22);
  const distant = Number(server.remotePort ?? 9876);
  for (const [quoi, valeur] of [['port', port], ['remotePort', distant]]) {
    if (!Number.isInteger(valeur) || valeur < 1 || valeur > 65535) {
      throw new InventoryError(`« ${quoi} » hors bornes pour « ${nom} » : ${valeur}.`);
    }
  }

  return { name: nom, host: hote, user: String(server.user ?? 'root'), port, remotePort: distant };
}

export async function load(path = DEFAULT_PATH) {
  let brut;
  try {
    brut = await readFile(path, 'utf8');
  } catch (erreur) {
    if (erreur.code === 'ENOENT') return [];
    throw new InventoryError(`Inventaire illisible (${path}) : ${erreur.message}`);
  }
  let donnees;
  try {
    donnees = JSON.parse(brut);
  } catch (erreur) {
    // Mieux vaut échouer que repartir d'un inventaire vide : l'exploitant
    // croirait avoir perdu ses serveurs.
    throw new InventoryError(`Inventaire illisible (${path}) : ${erreur.message}`);
  }
  if (!Array.isArray(donnees)) {
    throw new InventoryError(`Inventaire illisible (${path}) : une liste est attendue.`);
  }
  return donnees.map(validate);
}

export async function save(servers, path = DEFAULT_PATH) {
  const propres = servers.map(validate).map((s) =>
    Object.fromEntries(ALLOWED.map((k) => [k, s[k]])),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(propres, null, 2) + '\n', { mode: 0o600 });
  return propres;
}
