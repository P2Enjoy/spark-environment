/**
 * Coller un `.env` : l'analyse du texte, puis la modale à deux pas.
 *
 * @spec docs/BACKLOG.md#SPK-97 · docs/DAT.md §43.10 (coller un lot), §43.10.1
 *       (la grammaire lue, et ce qu'elle refuse), §43.10.2 (le secret reste
 *       DÉCLARÉ), §43.10.3 (la route de lot et ses refus), §43.9.7 (l'encodage
 *       dont ceci est l'inverse) · docs/DESIGN_SYSTEM_APP.md SPK-DS-23,
 *       SPK-DS-15 (une valeur d'un seul jeton se replie) ·
 *       docs/DESIGN_SYSTEM.md §6.27 (modale limitée à une section, refus DANS
 *       la modale), §6.9 (champ), §6.14 (tableau), §9.9 (désactivé mais
 *       visible), §14.3 (ne pas repeindre en cours de frappe), §14.5 (l'absence
 *       se nomme)
 *
 * **L'analyse vit ici, pas sur la Forge.** Le serveur ne reçoit jamais le texte
 * collé : il reçoit des entrées structurées (§43.10.3). C'est ce qui lui permet
 * de refuser sans deviner ce qu'une ligne voulait dire — et c'est ce qui permet
 * ici de montrer les refus AVANT d'écrire quoi que ce soit.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * La grammaire du shell, MIROIR de `environnement.NOM` côté Forge (§43.9.1).
 *
 * Elle est écrite deux fois, et c'est assumé : la console ne peut pas demander à
 * la Forge son verdict à chaque ligne collée. Le serveur revalide tout le lot et
 * le refuse en entier (§43.10.3) — c'est lui qui fait foi ; cette copie ne sert
 * qu'à nommer la ligne fautive avant l'aller-retour.
 */
export const NOM = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** L'état de la modale d'import. `open` porte la portée visée, comme `ENV_VIDE`. */
export const IMPORT_VIDE = {
  open: null,          // 'forge' | 'spark'
  pas: 'coller',       // 'coller' | 'relire'
  texte: '',
  toutSecret: false,
  lignes: [],          // { nom, valeur, secret, ligne }
  refus: [],           // { ligne, texte, raison }
  supplantees: [],     // { ligne, nom, gagnante }
  busy: false,
  refusal: null,
  confirming: null,    // { message, protected_sparks } — §43.9.5 bis
};

//: L'inverse EXACT de `citer()` (§43.9.7). Un échappement inconnu rend son
//: caractère : `\$` donne `$`, ce que l'encodage du produit écrit.
const ECHAPPES = { n: '\n', r: '\r', t: '\t' };
const desechapper = (v) => v.replace(/\\(.)/g, (_, c) => ECHAPPES[c] ?? c);

//: Sans `$` : ce qui SUIT le guillemet fermant doit pouvoir être constaté.
const DOUBLE = /^"((?:[^"\\]|\\.)*)"/;
const SIMPLE = /^'([^']*)'/;

/**
 * Lit la partie droite d'une ligne. Rend `{ valeur }` ou `{ raison }`.
 *
 * Une valeur multiligne est REFUSÉE et non devinée : accepter obligerait à
 * chercher où elle finit, et une clé privée tronquée en silence ne se voit qu'au
 * démarrage de la pile, loin du geste (§43.10.1).
 */
export function lireValeur(brut) {
  const v = String(brut ?? '').trim();
  if (!v.startsWith('"') && !v.startsWith("'")) {
    // Aucun commentaire de fin de ligne : `p@ss#word` garde son `#` (§43.10.1).
    return { valeur: v };
  }
  const cite = (v.startsWith('"') ? DOUBLE : SIMPLE).exec(v);
  if (!cite) {
    return { raison: 'la valeur ouvre un guillemet qu’elle ne referme pas sur '
                   + 'cette ligne. Une valeur multiligne n’est pas prise en '
                   + 'charge : écrivez « \\n ».' };
  }
  if (cite[0].length !== v.length) {
    return { raison: 'du texte suit le guillemet fermant. La valeur s’arrête au '
                   + 'guillemet, et le reste ne serait pas écrit.' };
  }
  return { valeur: v.startsWith('"') ? desechapper(cite[1]) : cite[1] };
}

/**
 * Analyse un texte collé (§43.10.1).
 *
 * Rend trois listes, et les trois se rendent à l'écran : ce qui sera écrit, ce
 * qui est refusé **avec son numéro de ligne**, et ce qui est supplanté par une
 * ligne plus bas. Jeter les deux dernières en silence donnerait un import
 * « réussi » à qui a collé quarante lignes et en a écrit trente-sept.
 */
export function analyser(texte, { secretParDefaut = false } = {}) {
  const lues = [];
  const refus = [];

  String(texte ?? '').split(/\r?\n/).forEach((brut, index) => {
    const numero = index + 1;
    const ligne = brut.trim();
    // Un `#` n'ouvre un commentaire qu'en DÉBUT de ligne (§43.10.1).
    if (!ligne || ligne.startsWith('#')) return;

    const utile = ligne.startsWith('export ') ? ligne.slice(7).trim() : ligne;
    const coupe = utile.indexOf('=');
    if (coupe < 0) {
      refus.push({ ligne: numero, texte: ligne,
                   raison: 'aucun « = » : la ligne ne dit pas quelle variable '
                         + 'elle définit.' });
      return;
    }
    const nom = utile.slice(0, coupe).trim();
    if (!NOM.test(nom)) {
      refus.push({ ligne: numero, texte: ligne,
                   raison: `« ${nom} » n’est pas un nom exportable : il faut une `
                         + 'lettre ou un souligné, puis des lettres, chiffres et '
                         + 'soulignés.' });
      return;
    }
    const lu = lireValeur(utile.slice(coupe + 1));
    if (lu.raison) {
      refus.push({ ligne: numero, texte: ligne, raison: lu.raison });
      return;
    }
    lues.push({ nom, valeur: lu.valeur, secret: Boolean(secretParDefaut), ligne: numero });
  });

  // La règle du shell : la DERNIÈRE ligne l'emporte. Et la perdante le dit —
  // appliquer la règle sans l'écrire ferait chercher longtemps pourquoi la
  // valeur posée n'est pas celle qu'on lit dans son texte (SPK-DS-23).
  const dernier = new Map();
  lues.forEach((e) => dernier.set(e.nom, e.ligne));
  const supplantees = lues
    .filter((e) => dernier.get(e.nom) !== e.ligne)
    .map((e) => ({ ligne: e.ligne, nom: e.nom, gagnante: dernier.get(e.nom) }));

  return {
    entrees: lues.filter((e) => dernier.get(e.nom) === e.ligne),
    refus,
    supplantees,
  };
}

/**
 * Ce que le lot fera d'un nom (SPK-DS-23).
 *
 * Trois effets et non deux : sur un Spark, importer un nom qui porte une entrée
 * du catalogue COCHÉE ne remplace rien — il la MASQUE (§43.9.4). Le dire
 * « nouvelle entrée » enverrait chercher la valeur là où elle n'agit plus.
 */
export function decrireEffet(nom, existantes = [], cochees = []) {
  if (existantes.includes(nom)) {
    return { texte: 'remplace la valeur actuelle', token: 'accent' };
  }
  if (cochees.includes(nom)) {
    return { texte: 'masque une entrée cochée', token: 'accent' };
  }
  return { texte: 'nouvelle entrée', token: 'neutral' };
}

function renderColler(ui) {
  return `
  <div class="champ">
    <label for="import-env-texte">Variables à importer</label>
    <textarea class="controle controle--zone technique" id="import-env-texte"
              name="texte" rows="10" spellcheck="false"
              placeholder="SMTP_HOST=mail.exemple.fr&#10;SMTP_PORT=587&#10;SMTP_PASSWORD=&quot;mot de passe&quot;">${
      echapper(ui.texte)}</textarea>
    <p class="champ__aide">Une variable par ligne, <code class="technique">NOM=valeur</code>, comme
    dans un fichier <code class="technique">.env</code>. <code class="technique">export</code> est toléré, les lignes
    vides et celles qui commencent par <code class="technique">#</code> sont ignorées. Une valeur
    peut être entre guillemets ; elle tient sur une seule ligne.</p>
  </div>
  <div class="champ">
    <label for="import-env-secret">
      <input type="checkbox" id="import-env-secret" name="tout_secret"
             ${ui.toutSecret ? 'checked' : ''}> Déclarer toutes ces valeurs secrètes
    </label>
    <p class="champ__aide">Une case par ligne restera modifiable à l’étape
    suivante. Le produit ne devine jamais qu’une valeur est secrète : un nom ne
    dit pas ce qu’il porte.</p>
  </div>
  <p class="note">Rien n’est écrit à cette étape : le texte est d’abord analysé,
  et vous verrez ligne par ligne ce qui sera posé.
  <a href="#/manuel/M8">Manuel M8 — Exploiter au quotidien</a></p>`;
}

function ligneRelue(entree, existantes, cochees) {
  const effet = decrireEffet(entree.nom, existantes, cochees);
  return `<tr>
    <th scope="row" class="technique nom-cellule">${echapper(entree.nom)}</th>
    <td class="import-valeur technique">${entree.valeur === ''
      // §14.5 : une valeur vide est une VALEUR, et elle se nomme. Une cellule
      // blanche se lirait comme une ligne qu'on a oublié de remplir.
      ? '<span class="absence">valeur vide</span>'
      : echapper(entree.valeur)}</td>
    <td><label class="sr-only" for="import-secret-${echapper(entree.nom)}">Déclarer
      ${echapper(entree.nom)} secrète</label>
      <input type="checkbox" id="import-secret-${echapper(entree.nom)}"
             data-import-secret="${echapper(entree.nom)}"
             ${entree.secret ? 'checked' : ''}></td>
    <td><span class="badge badge--${effet.token}">${echapper(effet.texte)}</span></td>
  </tr>`;
}

function renderRelire(ui, existantes, cochees) {
  const { lignes, refus, supplantees } = ui;

  const tableau = lignes.length ? `<div class="tableau-enveloppe">
    <p class="tableau-indice">Le tableau défile horizontalement.</p>
    <table>
      <thead><tr><th scope="col">Nom</th><th scope="col">Valeur</th>
        <th scope="col">Secret</th><th scope="col">Ce qui arrivera</th></tr></thead>
      <tbody>${lignes.map((e) => ligneRelue(e, existantes, cochees)).join('')}</tbody>
    </table>
  </div>`
    // §14.5 : l'absence est un fait, et elle dit ce qu'elle implique.
    : `<p class="absence">Aucune ligne exploitable dans ce texte : il n’y a rien
       à importer.</p>`;

  const refuses = refus.length ? `<div class="refus" role="alert">
    <p><strong>${refus.length} ligne${refus.length > 1 ? 's' : ''} ne ser${
      refus.length > 1 ? 'ont' : 'a'} pas importée${refus.length > 1 ? 's' : ''}</strong></p>
    <ul class="import-refus">${refus.map((r) => `<li>
      <span class="technique">ligne ${r.ligne}</span> — ${echapper(r.raison)}
      <span class="import-source technique">${echapper(r.texte)}</span></li>`).join('')}</ul>
  </div>` : '';

  const doubles = supplantees.length ? `<p class="note">${supplantees.map((s) =>
    `La ligne ${s.ligne} définit « ${echapper(s.nom)} » une première fois : c’est
     la ligne ${s.gagnante} qui l’emporte, comme dans un shell.`).join(' ')}</p>` : '';

  // §43.9.5 bis : informer, PUIS accepter. La confirmation reste dans le flux de
  // la modale (§6.27) — jamais une seconde modale par-dessus la première.
  const proteges = ui.confirming?.protected_sparks ?? [];
  const confirmation = ui.confirming ? `<div class="confirmation" role="group"
      aria-label="Confirmer l’import malgré les protections">
    <p><strong>${echapper(ui.confirming.message)}</strong></p>
    ${proteges.length ? `<p class="note">Spark${proteges.length > 1 ? 's' : ''}
      concerné${proteges.length > 1 ? 's' : ''} : ${echapper(proteges.join(', '))}.</p>` : ''}
    <p class="confirmation__consequence">Aucune protection ne sera levée.</p>
  </div>` : '';

  const entete = lignes.length
    ? `<p class="note">${lignes.length} entrée${lignes.length > 1 ? 's' : ''} lue${
        lignes.length > 1 ? 's' : ''} dans le texte collé. Cochez ce qui doit être
      déclaré secret : une valeur secrète ne se relit plus jamais.</p>`
    // §1.4 : pas de commande morte. Inviter à cocher sous zéro ligne demande un
    // geste sans objet ; ce qu'il faut lire est le refus, juste dessous.
    : '';

  return `
  ${entete}
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-import-retour>Corriger le texte</button>
  </p>
  ${tableau}
  ${doubles}
  ${refuses}
  ${confirmation}`;
}

/**
 * La modale entière, aux deux pas (SPK-DS-23).
 *
 * `existantes` porte les noms déjà définis dans la portée visée, `cochees` ceux
 * qui descendent du catalogue sur ce Spark : c'est ce qui permet d'annoncer un
 * remplacement — ou un masquage — AVANT de l'écrire.
 */
export function renderImportEnv({ portee = 'forge', ui = IMPORT_VIDE,
                                  existantes = [], cochees = [],
                                  renderModale = () => '' } = {}) {
  const relire = ui.pas === 'relire';
  const rien = relire && !ui.lignes.length;
  return renderModale({
    ouverte: Boolean(ui.open),
    id: 'env-import',
    titre: portee === 'forge'
      ? 'Importer au catalogue de la Forge'
      : 'Importer dans ce Spark',
    // §9.9 : l'action EXISTE et reste visible ; son indisponibilité est un état
    // connu et nommable — le texte ne porte aucune ligne exploitable.
    engagement: relire
      ? (ui.confirming ? 'Continuer malgré les protections'
                       : `Importer ${ui.lignes.length} entrée${ui.lignes.length > 1 ? 's' : ''}`)
      : 'Analyser',
    desactivee: rien,
    indication: rien ? 'Corrigez le texte : aucune ligne n’est exploitable.' : null,
    refus: ui.refusal,
    occupee: ui.busy,
    corps: relire ? renderRelire(ui, existantes, cochees) : renderColler(ui),
  });
}
