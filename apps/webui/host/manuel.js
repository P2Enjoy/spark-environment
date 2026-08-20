/**
 * Le manuel, servi par l'hôte console.
 *
 * @spec docs/BACKLOG.md#SPK-56 · docs/DESIGN_SYSTEM.md §1.5 bis (l'écran nomme,
 *       le manuel explique) · docs/DAT.md §30 (le manuel et sa fraîcheur)
 *
 * Le §1.5 bis sort les explications des écrans et les renvoie au manuel. Un
 * renvoi qui ne mène nulle part serait une commande morte (§1.4) : le manuel
 * doit donc être ATTEIGNABLE depuis la console, et pas seulement exister dans le
 * dépôt.
 *
 * Il est servi depuis `docs/manuel/`, la source unique. Le recopier dans la
 * console en ferait une seconde version, qui divergerait — c'est exactement le
 * défaut que le §1.5 bis corrige.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Un chapitre est `M<numéro>-<nom>`. Rien d'autre n'est lisible : le nom vient
 *  de l'URL, donc il ne doit pas pouvoir désigner un fichier arbitraire. */
const CHAPITRE = /^M\d{1,2}(-[a-z0-9-]+)?$/;
const IMAGE = /^[a-z0-9._-]+\.(png|jpe?g|svg|webp)$/i;

const TYPES_IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                      '.svg': 'image/svg+xml', '.webp': 'image/webp' };

export class ManuelError extends Error {}

/** Titre lisible : la première ligne `# …` du chapitre. */
export function titreDe(markdown, repli) {
  const ligne = String(markdown).split('\n').find((l) => l.startsWith('# '));
  return ligne ? ligne.slice(2).trim() : repli;
}

/**
 * Chapitres disponibles, dans l'ordre des numéros — `M2` avant `M10`, ce qu'un
 * tri alphabétique ne fait pas.
 */
export async function chapitres(racine) {
  const fichiers = (await readdir(racine)).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const liste = [];
  for (const fichier of fichiers) {
    const id = fichier.replace(/\.md$/, '');
    if (!CHAPITRE.test(id)) continue;
    const markdown = await readFile(join(racine, fichier), 'utf8');
    liste.push({ id, numero: Number(id.slice(1).split('-')[0]), titre: titreDe(markdown, id) });
  }
  return liste.sort((a, b) => a.numero - b.numero);
}

/**
 * Contenu d'un chapitre. Le nom est validé AVANT de toucher au disque.
 *
 * Un renvoi d'écran désigne un chapitre par son NUMÉRO — « M4 » —, jamais par le
 * nom de son fichier : le slug est un détail d'écriture, et un renvoi qui en
 * dépendrait casserait le jour où l'on renomme un chapitre.
 */
export async function chapitre(racine, id) {
  const demande = String(id ?? '');
  if (!CHAPITRE.test(demande)) {
    throw new ManuelError(`Chapitre « ${id} » inconnu.`);
  }
  let fichier = `${demande}.md`;
  if (/^M\d{1,2}$/.test(demande)) {
    const trouve = (await readdir(racine))
      .find((f) => f.startsWith(`${demande}-`) && f.endsWith('.md'));
    if (!trouve) throw new ManuelError(`Chapitre « ${id} » absent du manuel.`);
    fichier = trouve;
  }
  try {
    return await readFile(join(racine, fichier), 'utf8');
  } catch {
    throw new ManuelError(`Chapitre « ${id} » absent du manuel.`);
  }
}

/** Illustration d'un chapitre, telle que le harnais du §30 la produit. */
export async function image(racine, nom) {
  if (!IMAGE.test(String(nom ?? ''))) {
    throw new ManuelError(`Image « ${nom } » refusée.`);
  }
  const extension = String(nom).slice(String(nom).lastIndexOf('.')).toLowerCase();
  return { contenu: await readFile(join(racine, 'images', nom)),
           type: TYPES_IMAGE[extension] ?? 'application/octet-stream' };
}
