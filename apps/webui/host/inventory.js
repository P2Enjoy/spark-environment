/**
 * Inventaire des serveurs administrés.
 *
 * @spec docs/BACKLOG.md#SPK-16, docs/BACKLOG.md#SPK-23 ·
 *       docs/DAT.md §22.4 (aucun secret), §28.2 (le serveur local)
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
const ALLOWED = ['name', 'kind', 'host', 'user', 'port', 'remotePort'];

/**
 * Genres de serveur.
 *
 * `ssh` est le cas normal : `sparkd` est sur une autre machine, et seul un
 * porteur de clé l'atteint. `local` sert la pile de développement, où `sparkd`
 * écoute déjà sur la boucle locale de CETTE machine (docs/DAT.md §28.2) : y
 * ouvrir un tunnel SSH exigerait un `sshd` et des clés pour n'accomplir aucun
 * transport.
 *
 * Ce n'est pas un contournement, et pour une raison qui ne dépend pas de la
 * bonne volonté de l'appelant : `sparkd` REFUSE de démarrer sur une adresse
 * routable. Un accès direct ne peut donc joindre qu'un `sparkd` de boucle
 * locale — exactement ce que le tunnel garantissait à distance.
 */
export const KINDS = ['ssh', 'local'];

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
  const genre = String(server?.kind ?? 'ssh').trim();
  if (!KINDS.includes(genre)) {
    throw new InventoryError(
      `Genre « ${server?.kind} » inconnu pour « ${nom} » : attendu ${KINDS.join(' ou ')}.`,
    );
  }
  // Un serveur local n'a ni hôte, ni utilisateur, ni port distant : les exiger
  // obligerait à inventer des valeurs qui ne servent à rien (§28.2).
  const hote = genre === 'local' ? '127.0.0.1' : String(server?.host ?? '').trim();
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

  if (genre === 'local') return { name: nom, kind: genre, host: hote, port: distant };
  return { name: nom, kind: genre, host: hote,
           user: String(server.user ?? 'root'), port, remotePort: distant };
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
