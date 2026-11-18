/**
 * La grammaire d'une proposition de sondes (`health.?`), lue côté console.
 *
 * @spec docs/BACKLOG.md#SPK-185 · docs/DAT.md §75.9 (la paire `health` / `health.?`,
 *       la grammaire, valider avant d'accepter), §55.8 (la grammaire vit dans la
 *       console, le serveur reçoit des entrées structurées) ·
 *       docs/DESIGN_SYSTEM.md §14.6 (une absence se nomme)
 *
 * **L'analyse vit ici, pas sur la Forge** — comme celle d'un `.env` collé
 * (`env-import.js`). Le serveur ne lit jamais le texte de la cellule : il reçoit des
 * entrées structurées et les REVALIDE toutes (`POST …/health/validate`, puis `PUT`).
 * Cette copie ne sert qu'à nommer la ligne fautive avant l'aller-retour ; elle ne
 * décide d'aucune route ni d'aucun domaine — c'est le serveur qui sait quelles routes
 * le Spark déclare.
 *
 * Une ligne : `<nom> <type> <cadence : 5 champs> <seuil> <attendu> <cible…>`. La cible
 * va en DERNIER : une commande contient des espaces, une adresse n'en contient pas.
 */

/** Miroir de `health.NOM` côté Forge. */
export const NOM_SONDE = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;
export const TYPES_SONDE = ['http', 'script'];

//: `<nom> <type> <5 champs> <seuil> <attendu> <cible…>` — les cinq champs de la cadence
//: sont des mots séparés par des blancs ; la cible est le RESTE de la ligne.
const LIGNE = /^(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(\S+)\s+(\S.*?)\s*$/;

const entier = (texte) => (/^\d+$/.test(texte) ? Number(texte) : null);

/**
 * Lit UNE ligne de déclaration. Rend `{ entree }` ou `{ raison }`.
 *
 * Ne vérifie que la FORME : un domaine qui n'est pas une route du Spark, ou une
 * cadence plus serrée que cinq minutes, sont des refus du serveur, qui seul sait.
 */
export function lireLigne(ligne) {
  const trouve = LIGNE.exec(ligne.trim());
  if (!trouve) {
    return { raison: 'Format attendu : nom type cadence (5 champs) seuil attendu cible.' };
  }
  const [, name, kind, cadence, seuil, attendu, cible] = trouve;
  if (!NOM_SONDE.test(name)) {
    return { raison: `Nom « ${name} » invalide : minuscules, chiffres et tirets.` };
  }
  if (!TYPES_SONDE.includes(kind)) {
    return { raison: `Type « ${kind} » inconnu : http ou script.` };
  }
  const threshold = entier(seuil);
  if (threshold === null || threshold < 1 || threshold > 20) {
    return { raison: `Seuil « ${seuil} » : un entier de 1 à 20.` };
  }
  const expected = entier(attendu);
  const [mini, maxi, nom] = kind === 'http' ? [100, 599, 'Statut'] : [0, 255, 'Code de sortie'];
  if (expected === null || expected < mini || expected > maxi) {
    return { raison: `${nom} attendu « ${attendu} » : un entier de ${mini} à ${maxi}.` };
  }
  if (kind === 'http' && !/^https:\/\//i.test(cible)) {
    return { raison: 'Une sonde http vise https://<un domaine de vos routes>/<chemin>.' };
  }
  return {
    entree: {
      name, kind, schedule: cadence.split(/\s+/).join(' '), threshold, expected, target: cible,
    },
  };
}

/**
 * Lit le CORPS d'un `health.?` (l'en-tête du produit est déjà retiré par la Forge).
 *
 * Rend `{ entrees, refus, supplantees }` :
 *
 * - `entrees` : les lignes lisibles, dans l'ordre, chacune avec son numéro de ligne et
 *   l'étiquette d'auteur — un commentaire `#` posé JUSTE au-dessus, sans ligne vide ;
 * - `refus` : ce qui ne se lit pas, avec la raison, jamais en silence ;
 * - `supplantees` : un nom déclaré deux fois — la dernière l'emporte, la première est dite.
 */
export function lireProposition(corps) {
  const entrees = [];
  const refus = [];
  const supplantees = [];
  let etiquette = null;
  String(corps ?? '').split(/\r?\n/).forEach((brut, index) => {
    const numero = index + 1;
    const ligne = brut.trim();
    if (ligne === '') { etiquette = null; return; }
    if (ligne.startsWith('#')) { etiquette = ligne.replace(/^#+\s*/, '') || null; return; }
    const lue = lireLigne(ligne);
    if (lue.raison) {
      refus.push({ ligne: numero, texte: ligne, raison: lue.raison });
    } else {
      const precedente = entrees.findIndex((e) => e.name === lue.entree.name);
      if (precedente >= 0) {
        supplantees.push({ ligne: entrees[precedente].ligne, nom: lue.entree.name, gagnante: numero });
        entrees.splice(precedente, 1);
      }
      entrees.push({ ...lue.entree, ligne: numero, commentaire: etiquette });
    }
    etiquette = null;
  });
  return { entrees, refus, supplantees };
}

/** Ce que le serveur reçoit pour UNE ligne retenue : la définition, sans le décor de lecture. */
export function definitionDe(entree) {
  const { name, kind, schedule, threshold, expected, target } = entree;
  return { name, kind, schedule, threshold, expected, target };
}

/**
 * Le compte que l'écran dit d'une proposition, sans en lire le contenu en détail.
 * « Une ligne script » se montre autrement qu'une ligne http : sa commande EXACTE.
 */
export function resume(entrees) {
  const scripts = entrees.filter((e) => e.kind === 'script').length;
  return { total: entrees.length, scripts, http: entrees.length - scripts };
}
