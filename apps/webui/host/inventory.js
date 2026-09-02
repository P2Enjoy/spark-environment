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
// `signingKey` (SPK-40, §36.10.8) : un chemin vers une clé PUBLIQUE. Aucun
// secret n'entre ici — le §11 garde les clés privées sur le poste, et c'est
// l'agent qui signe.
// `publicAddress` (SPK-77, §38.8.5) : l'adresse par laquelle le MONDE atteint
// cette Forge. Elle ne se déduit pas toujours du transport — un alias `ssh` la
// cache dans le `ssh_config`, et l'hôte d'une Forge locale est une boucle
// locale. Facultative : absente, elle est déduite comme avant.
const ALLOWED = ['name', 'kind', 'host', 'user', 'port', 'remotePort', 'sshHost',
                 'signingKey', 'publicAddress'];

/**
 * Version de la forme du fichier (docs/DAT.md §22.4.2).
 *
 * La forme historique — un TABLEAU NU — est lue comme la version 0 et convertie
 * en mémoire. Elle n'est jamais réécrite à la LECTURE : une console qui migrerait
 * le fichier en l'affichant le récrirait sans qu'on l'ait demandé. La conversion
 * est écrite au premier enregistrement, qui est un geste explicite.
 */
export const VERSION = 1;

/**
 * Genres de serveur.
 *
 * `ssh` est le cas normal : `sparkd` est sur une autre machine, et seul un
 * porteur de clé l'atteint. `alias` délègue TOUT à OpenSSH — l'entrée ne nomme
 * qu'un `Host` du `~/.ssh/config`, et le produit ne connaît ni l'utilisateur, ni
 * le port, ni le rebond (docs/DAT.md §22.4 bis). Les deviner donnerait l'illusion
 * de les connaître, et ils seraient faux dès qu'un `ProxyJump` s'interpose.
 * `local` sert la pile de développement, où `sparkd`
 * écoute déjà sur la boucle locale de CETTE machine (docs/DAT.md §28.2) : y
 * ouvrir un tunnel SSH exigerait un `sshd` et des clés pour n'accomplir aucun
 * transport.
 *
 * Ce n'est pas un contournement, et pour une raison qui ne dépend pas de la
 * bonne volonté de l'appelant : `sparkd` REFUSE de démarrer sur une adresse
 * routable. Un accès direct ne peut donc joindre qu'un `sparkd` de boucle
 * locale — exactement ce que le tunnel garantissait à distance.
 */
export const KINDS = ['ssh', 'alias', 'local'];

/** Motifs qui trahissent un secret glissé par erreur dans l'inventaire.
 *
 *  EXPORTÉ pour que les preuves emploient CE motif plutôt qu'une seconde règle
 *  écrite à côté : deux heuristiques finissent par diverger, et celle du parcours
 *  prenait `signingKey` — un chemin vers une clé PUBLIQUE — pour un secret. */
export const SECRET_HINT = /private[_-]?key|password|passphrase|secret|token|BEGIN [A-Z ]*PRIVATE KEY/i;

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
  // Une entrée `alias` ne porte QUE le nom d'un `Host` du ssh_config : c'est
  // OpenSSH qui résout le reste (§22.4 bis).
  const alias = genre === 'alias';
  const sshHost = alias ? String(server?.sshHost ?? '').trim() : '';
  if (alias && !sshHost) {
    throw new InventoryError(
      `Le serveur « ${nom} » est déclaré par alias mais n'en nomme aucun : ` +
        `indiquez un « Host » de votre ~/.ssh/config.`,
    );
  }

  // Un serveur local n'a ni hôte, ni utilisateur, ni port distant : les exiger
  // obligerait à inventer des valeurs qui ne servent à rien (§28.2).
  const hote = genre === 'local' ? '127.0.0.1'
    : alias ? sshHost : String(server?.host ?? '').trim();
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

  // Un serveur SSH porte DEUX ports : celui de `sshd` et celui de `sparkd` à
  // l'autre bout. Un serveur local n'en a qu'un, celui où `sparkd` écoute ici.
  const local = genre === 'local';
  // SPK-40 · §36.10.8 : la clé de SIGNATURE, si ce serveur en a une. Absente,
  // ce serveur n'est simplement pas signé — un état normal, pas une panne. Elle
  // est jointe à TOUS les genres : signer ne dépend pas de la façon d'atteindre
  // la Forge.
  const signature = server.signingKey
    ? { signingKey: String(server.signingKey) } : {};
  // SPK-77 · §38.8.5 : DÉCLARÉE, jamais devinée. Une boucle locale n'est pas une
  // adresse publique, et l'accepter ferait rapprocher l'inventaire DNS sur une
  // adresse que personne ne peut atteindre.
  const declaree = String(server.publicAddress ?? '').trim();
  if (declaree && ['127.0.0.1', 'localhost', '::1'].includes(declaree)) {
    throw new InventoryError(
      `« publicAddress » ne peut pas être une boucle locale pour « ${nom} » : `
      + `c'est l'adresse par laquelle le monde atteint cette Forge.`);
  }
  const publique = declaree ? { publicAddress: declaree } : {};

  if (alias) {
    // Ni `user` ni `port` : le produit ne prétend pas les connaître.
    const distantAlias = Number(server.remotePort ?? 9876);
    if (!Number.isInteger(distantAlias) || distantAlias < 1 || distantAlias > 65535) {
      throw new InventoryError(`« remotePort » hors bornes pour « ${nom} » : ${distantAlias}.`);
    }
    return { name: nom, kind: genre, sshHost, remotePort: distantAlias,
             ...signature, ...publique };
  }
  const port = local
    // `port` d'abord, `remotePort` ensuite : l'aller-retour doit rendre ce qui
    // a été écrit. Lire `remotePort` en premier jetait le port fourni et rendait
    // toujours 9876 — un harnais qui monte sa pile sur un port libre pointait
    // alors sur un `sparkd` qui n'était pas le sien.
    ? Number(server.port ?? server.remotePort ?? 9876)
    : Number(server.port ?? 22);
  const distant = Number(server.remotePort ?? 9876);
  const bornes = local ? [['port', port]] : [['port', port], ['remotePort', distant]];
  for (const [quoi, valeur] of bornes) {
    if (!Number.isInteger(valeur) || valeur < 1 || valeur > 65535) {
      throw new InventoryError(`« ${quoi} » hors bornes pour « ${nom} » : ${valeur}.`);
    }
  }

  if (local) return { name: nom, kind: genre, host: hote, port,
                      ...signature, ...publique };
  return { name: nom, kind: genre, host: hote,
           user: String(server.user ?? 'root'), port, remotePort: distant,
           ...signature, ...publique };
}

/**
 * Lit le fichier ENTIER : serveurs, serveur courant, ancres (docs/DAT.md §22.4.2).
 *
 * La forme historique — un tableau nu — est lue comme la version 0. Elle n'est
 * PAS réécrite ici : une console qui migrerait le fichier en l'affichant le
 * récrirait sans qu'on l'ait demandé. La conversion est écrite au premier
 * enregistrement, qui est un geste explicite.
 */
export async function loadFile(path = DEFAULT_PATH) {
  let brut;
  try {
    brut = await readFile(path, 'utf8');
  } catch (erreur) {
    if (erreur.code === 'ENOENT') return { version: VERSION, servers: [], current: null, anchors: {} };
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
  if (Array.isArray(donnees)) {
    return { version: 0, servers: donnees.map(validate), current: null, anchors: {} };
  }
  if (!donnees || typeof donnees !== 'object' || !Array.isArray(donnees.servers)) {
    throw new InventoryError(
      `Inventaire illisible (${path}) : une liste ou un objet « servers » est attendu.`);
  }
  const serveurs = donnees.servers.map(validate);
  // Un `current` qui ne désigne aucun serveur existant vaut `null` : le garder
  // ferait chercher un serveur qui n'est plus là.
  const courant = serveurs.some((s) => s.name === donnees.current) ? donnees.current : null;
  return {
    version: Number(donnees.version ?? VERSION),
    servers: serveurs,
    current: courant,
    anchors: (donnees.anchors && typeof donnees.anchors === 'object') ? donnees.anchors : {},
  };
}

/** Les serveurs seuls. Forme historique, conservée pour ses appelants. */
export async function load(path = DEFAULT_PATH) {
  return (await loadFile(path)).servers;
}

/** Écrit le fichier ENTIER, dans la forme courante. */
export async function saveFile({ servers = [], current = null, anchors = {} } = {},
                               path = DEFAULT_PATH) {
  const propres = servers.map(validate).map((s) =>
    // Un champ absent du genre — `user` pour un alias — ne doit pas être écrit
    // à `undefined` : `JSON.stringify` l'omettrait, mais un `null` explicite
    // ferait croire à une valeur vide plutôt qu'à une absence.
    Object.fromEntries(ALLOWED.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])),
  );
  const courant = propres.some((s) => s.name === current) ? current : null;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(
    { version: VERSION, servers: propres, current: courant, anchors }, null, 2) + '\n',
    { mode: 0o600 });
  return propres;
}

export async function save(servers, path = DEFAULT_PATH) {
  // Conserve le serveur courant et les ancres : enregistrer une liste ne doit
  // pas effacer un état qui vit dans le même fichier.
  const existant = await loadFile(path).catch(() => ({ current: null, anchors: {} }));
  return saveFile({ servers, current: existant.current, anchors: existant.anchors }, path);
}
