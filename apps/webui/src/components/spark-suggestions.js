/**
 * Ce qu'un agent PROPOSE depuis la cellule, et ce qu'on en fait.
 *
 * @spec docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.3 (les six paires), §55.3.1
 *       (la grammaire des routes), §55.5 (consulter ne consomme pas), §55.5.2
 *       (l'empreinte relue), §55.8 (l'analyse vit ICI, pas au serveur), §55.9
 *       (là où le geste se conclut) ·
 *       docs/DESIGN_SYSTEM.md §14.5 (l'absence se nomme), §14.6 (les états ne
 *       se confondent pas), §1.3 (pas de succès simulé), §6.10 (cases),
 *       §6.22 (la confirmation est intégrée au flux) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-23 (un lot s'analyse à l'écran avant
 *       d'être écrit), SPK-DS-27 (une proposition se lit à côté de sa cible)
 *
 * **L'analyse vit ici, comme celle du lot collé** (§43.10.3, §55.8) : le serveur
 * reçoit des entrées structurées, jamais du texte. Écrire un second analyseur en
 * Python ferait deux grammaires pour le même fichier, qui divergeraient.
 *
 * **Pas de modale.** Le §6.27 la réserve à la saisie ; ici rien n'est saisi — on
 * choisit parmi des lignes déjà à l'écran, et la décision se conclut dans le
 * flux (§6.22). Une modale ajouterait un piège de focus pour un geste qui n'en
 * a pas besoin.
 */

import { analyser } from './env-import.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** L'état des propositions, partagé par les facettes qui en montrent. */
export const PROPOSITIONS_VIDE = {
  status: 'vide',   // 'vide' | 'chargement' | 'pret' | 'erreur'
  items: [],        // ce que rend GET /suggestions
  cellLue: false,
  erreur: null,
  ouvert: null,     // la nature dépliée pour relecture
  exclues: {},      // { [kind]: Set des lignes écartées }
  secrets: {},      // { [kind]: Set des lignes cochées « secret » }
  busy: null,
  issue: null,      // { kind, ok, message }
};

/** Les libellés, en français. Une nature technique n'atteint pas l'écran (§14.7). */
const NATURES = {
  variables: { titre: 'Variables proposées', unite: 'variable' },
  secrets: { titre: 'Secrets proposés', unite: 'secret' },
  routes: { titre: 'Routes proposées', unite: 'route' },
};

/**
 * La grammaire de `/etc/spark/routes` (§55.3.1), écrite UNE fois.
 *
 * `<domaine> <port écouté dans la cellule> [tls|clair]`. Le défaut est `tls`,
 * parce que c'est le cas de tout ce qui parle HTTP derrière l'ingress (§18.3) —
 * un défaut en clair ferait proposer par inadvertance ce que personne ne veut.
 *
 * Elle refuse plutôt que de deviner, et NOMME la ligne fautive : c'est la même
 * discipline qu'au §43.10.1, et c'est elle qui permet de corriger sans relire
 * tout le fichier.
 */
export function analyserRoutes(texte) {
  const entrees = [];
  const refus = [];
  String(texte ?? '').split(/\r?\n/).forEach((brut, index) => {
    const numero = index + 1;
    const ligne = brut.trim();
    if (!ligne || ligne.startsWith('#')) return;
    const mots = ligne.split(/\s+/);
    if (mots.length < 2 || mots.length > 3) {
      refus.push({ ligne: numero, texte: ligne,
                   raison: 'il faut un domaine, un port, et au plus « tls » ou '
                         + '« clair ».' });
      return;
    }
    const [domaine, portBrut, mode] = mots;
    // Le même contrôle qu'à la saisie : le serveur refait le sien (§18.4), et
    // celui-ci ne sert qu'à nommer la ligne avant l'aller-retour.
    if (!/^[A-Za-z0-9*._-]+\.[A-Za-z]{2,}$/.test(domaine)) {
      refus.push({ ligne: numero, texte: ligne,
                   raison: `« ${domaine} » ne ressemble pas à un nom de domaine.` });
      return;
    }
    const port = Number(portBrut);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      refus.push({ ligne: numero, texte: ligne,
                   raison: `« ${portBrut} » n’est pas un port entre 1 et 65535.` });
      return;
    }
    if (mode !== undefined && mode !== 'tls' && mode !== 'clair') {
      refus.push({ ligne: numero, texte: ligne,
                   raison: `« ${mode} » n’est ni « tls » ni « clair ».` });
      return;
    }
    entrees.push({ domaine, port, tls: mode !== 'clair', ligne: numero });
  });
  return { entrees, refus };
}

/**
 * Ce que le produit a COMPRIS d'une proposition.
 *
 * C'est cela qui s'affiche, et cela qui part au serveur : montrer le texte brut
 * et envoyer autre chose serait faire relire ce qu'on n'applique pas (§55.8).
 */
export function comprendre(suggestion) {
  if (!suggestion?.present) return { entrees: [], refus: [] };
  return suggestion.kind === 'routes'
    ? analyserRoutes(suggestion.body)
    // Le chemin DIT la nature (§55.3), et l'écran la pré-coche en conséquence.
    // Le propriétaire garde le dernier mot, case par case (§43.10.2).
    : analyser(suggestion.body, { secretParDefaut: suggestion.kind === 'secrets' });
}

const retenue = (ui, kind, ligne) => !(ui.exclues?.[kind] ?? new Set()).has(ligne);
const estSecret = (ui, kind, ligne, defaut) =>
  (ui.secrets?.[kind] ?? null) ? ui.secrets[kind].has(ligne) : defaut;

/** Une ligne d'entrée, avec sa case de rétention et — pour l'env — sa case secret. */
function ligneEntree(kind, entree, ui) {
  const gardee = retenue(ui, kind, entree.ligne);
  if (kind === 'routes') {
    return `<tr>
      <td><input type="checkbox" data-sugg-garder="${kind}" data-ligne="${entree.ligne}"
        ${gardee ? 'checked' : ''} aria-label="Retenir la ligne ${entree.ligne}"></td>
      <th scope="row" class="technique nom-cellule">${echapper(entree.domaine)}</th>
      <td class="technique">${entree.port}</td>
      <td>${entree.tls ? 'TLS' : 'en clair'}</td>
    </tr>`;
  }
  const secret = estSecret(ui, kind, entree.ligne, entree.secret);
  return `<tr>
    <td><input type="checkbox" data-sugg-garder="${kind}" data-ligne="${entree.ligne}"
      ${gardee ? 'checked' : ''} aria-label="Retenir la ligne ${entree.ligne}"></td>
    <th scope="row" class="technique nom-cellule">${echapper(entree.nom)}</th>
    <td class="technique">${echapper(entree.valeur)}</td>
    <td><input type="checkbox" data-sugg-secret="${kind}" data-ligne="${entree.ligne}"
      ${secret ? 'checked' : ''} aria-label="Déclarer la ligne ${entree.ligne} secrète"></td>
  </tr>`;
}

/** Le tableau de relecture, ou le refus qui nomme la ligne fautive (§43.10.1). */
function relecture(suggestion, ui) {
  const { kind } = suggestion;
  const { entrees, refus } = comprendre(suggestion);
  const entetes = kind === 'routes'
    ? '<th>Retenir</th><th>Domaine</th><th>Port dans la cellule</th><th>TLS</th>'
    : '<th>Retenir</th><th>Nom</th><th>Valeur proposée</th><th>Secret</th>';
  const tableau = entrees.length
    ? `<div class="tableau-defilant"><table>
        <thead><tr>${entetes}</tr></thead>
        <tbody>${entrees.map((e) => ligneEntree(kind, e, ui)).join('')}</tbody>
      </table></div>`
    // §14.5 : rien de lisible n'est un FAIT, et il a un remède — corriger le
    // fichier. Le taire ferait croire à une panne de lecture.
    : `<p class="absence">Rien de lisible dans cette proposition : aucune ligne
       n’a pu être comprise.</p>`;
  const fautives = refus.length
    ? `<div class="refus" role="alert">
        <p><strong>${refus.length} ligne(s) refusée(s)</strong>, et elles ne
        seront pas appliquées. Leur auteur peut corriger le fichier dans la
        cellule — le refuser ici l’effacerait.</p>
        <ul>${refus.map((r) => `<li>ligne ${r.ligne} :
          <span class="technique">${echapper(r.texte)}</span> — ${echapper(r.raison)}</li>`).join('')}</ul>
      </div>`
    : '';
  return tableau + fautives;
}

/** Le bloc d'une nature : la bannière, puis la relecture quand on l'ouvre. */
function bloc(suggestion, ui) {
  const { kind } = suggestion;
  const libelle = NATURES[kind] ?? { titre: kind, unite: 'entrée' };
  const { entrees } = comprendre(suggestion);
  const ouvert = ui.ouvert === kind;
  const enCours = ui.busy === kind;
  const issue = ui.issue?.kind === kind ? ui.issue : null;
  const gardees = entrees.filter((e) => retenue(ui, kind, e.ligne));
  return `<section class="carte bloc proposition" data-proposition="${kind}"
    aria-labelledby="titre-sugg-${kind}">
    <h2 id="titre-sugg-${kind}">${echapper(libelle.titre)}</h2>
    <p class="avertissement" role="status">
      <strong>${entrees.length} ${echapper(libelle.unite)}(s) proposée(s) depuis la
      cellule.</strong> Rien n’est appliqué tant que vous n’avez pas tranché, et
      la lire ne l’efface pas.</p>
    <p class="note">Déposée dans
      <span class="technique">${echapper(suggestion.path)}</span> par quelqu’un qui
      travaille dans ce Spark. Le produit n’a pas vérifié ces valeurs : il les
      transporte.</p>
    ${issue
      ? `<p class="${issue.ok ? 'succes' : 'refus'}" role="${issue.ok ? 'status' : 'alert'}"
          >${echapper(issue.message)}</p>`
      : ''}
    <p class="formulaire__actions">
      <button type="button" class="bouton" data-sugg-ouvrir="${kind}"
        aria-expanded="${ouvert}">${ouvert ? 'Replier' : 'Relire ligne par ligne'}</button>
    </p>
    ${ouvert ? `${relecture(suggestion, ui)}
      <p class="formulaire__actions">
        <button type="button" class="bouton bouton--primaire"
          data-sugg-appliquer="${kind}" data-sha="${echapper(suggestion.sha256)}"
          ${enCours || !gardees.length ? 'disabled' : ''}>${
            enCours ? 'Application…' : `Ajouter les ${gardees.length} retenue(s)`}</button>
        <button type="button" class="bouton" data-sugg-refuser="${kind}"
          data-sha="${echapper(suggestion.sha256)}"
          ${enCours ? 'disabled' : ''}>Tout refuser</button>
      </p>
      <p class="note">Quel que soit votre choix, <strong>le fichier de la cellule
      est vidé</strong> : ce que vous n’avez pas retenu est refusé, pas ajourné.
      C’est ainsi que son auteur apprend qu’une décision a été prise.</p>` : ''}
  </section>`;
}

/**
 * Les propositions que CETTE facette montre.
 *
 * `natures` borne la liste : l'environnement montre les variables et les
 * secrets, les routes montrent les routes. Le geste se conclut là où vit
 * l'objet, jamais dans un écran à part (§55.9).
 *
 * Rien n'est rendu quand il n'y a rien : une bannière permanente « aucune
 * proposition » ajouterait du bruit à un écran déjà dense, pour un événement qui
 * se produit quelques fois dans la vie d'un Spark.
 */
export function renderPropositions(ui = PROPOSITIONS_VIDE, natures = []) {
  if (ui.status !== 'pret') return '';
  const vues = (ui.items ?? []).filter(
    (s) => natures.includes(s.kind) && s.present);
  const rendu = vues.map((s) => bloc(s, ui)).join('');
  // Vu à l'écran le 2026-09-14 : une fois la proposition appliquée, son bloc
  // disparaît — et le compte rendu avec lui. L'exploitant venait d'agir et
  // n'avait AUCUNE confirmation, ce que le §1.3 et le §6.11 refusent.
  //
  // Le compte rendu survit donc à la proposition qu'il décrit, seul, jusqu'à la
  // prochaine peinture qui le remplace.
  const orpheline = ui.issue && natures.includes(ui.issue.kind)
    && !vues.some((s) => s.kind === ui.issue.kind);
  return rendu + (orpheline ? comptRendu(ui.issue) : '');
}

/** Le compte rendu seul, quand la proposition qu'il décrit n'existe plus. */
function comptRendu(issue) {
  const libelle = NATURES[issue.kind] ?? { titre: issue.kind };
  return `<section class="carte bloc proposition" data-proposition="${issue.kind}"
    aria-labelledby="titre-sugg-${issue.kind}">
    <h2 id="titre-sugg-${issue.kind}">${echapper(libelle.titre)}</h2>
    <p class="${issue.ok ? 'succes' : 'refus'}" role="${issue.ok ? 'status' : 'alert'}"
      >${echapper(issue.message)}</p>
  </section>`;
}
