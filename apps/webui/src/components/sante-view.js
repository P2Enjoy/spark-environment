/**
 * La facette « Santé » d'un Spark : la liste des sondes, sa frise, et la modale qui en règle une.
 *
 * @spec docs/BACKLOG.md#SPK-186 · docs/DAT.md §75.10 (ce que la console en fait), §75.6 (la
 *       machine à états), §75.3 (la sonde HTTPS : un domaine du Spark, choisi, jamais saisi),
 *       §75.5 (le script : la commande exacte, et le compte qui l'exécute), §75.7 (l'alerte et
 *       son canal) · docs/DESIGN_SYSTEM_APP.md SPK-DS-51 · docs/DESIGN_SYSTEM.md §1.4 (pas de
 *       commande morte), §1.5 (la couleur ne porte pas seule), §6.13 (l'absence se nomme),
 *       §6.19 (liste plate), §6.22, §6.23, §6.24, §6.27, §14.6 (mesure indisponible)
 *
 * Des fonctions pures : des chaînes HTML, sans horloge ni réseau. La zone d'aperçu et le bouton
 * d'engagement sont séparés du reste PARCE QUE l'écran les met à jour SUR PLACE pendant la
 * frappe : repeindre la modale arracherait le focus au champ en cours de saisie (§14.3).
 */

import { renderModale } from './modale.js';
import { dateUtc } from './sla-view.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Les cadences courantes d'une sonde (DAT §75.4). Le menu n'est qu'une aide : seule la chaîne est envoyée. */
export const PRESETS_SANTE = [
  { schedule: '*/5 * * * *', libelle: 'Toutes les 5 minutes' },
  { schedule: '*/10 * * * *', libelle: 'Toutes les 10 minutes' },
  { schedule: '*/15 * * * *', libelle: 'Toutes les 15 minutes' },
  { schedule: '*/30 * * * *', libelle: 'Toutes les 30 minutes' },
  { schedule: '0 * * * *', libelle: 'Toutes les heures' },
  { schedule: '0 */6 * * *', libelle: 'Toutes les 6 heures' },
];
export const PERSONNALISEE = '';

export function presetPour(chaine) {
  const normalisee = String(chaine ?? '').trim().split(/\s+/).join(' ');
  return PRESETS_SANTE.find((p) => p.schedule === normalisee)?.schedule ?? PERSONNALISEE;
}

/** État de la modale et de ses gestes. `open` vaut `false`, `'neuve'` ou le nom de la sonde modifiée. */
export const SANTE_VIDE = {
  open: false,
  values: { name: '', kind: 'http', route: '', chemin: '/', expected: '200', commande: '',
            schedule: '*/5 * * * *', threshold: '3' },
  apercu: null,        // la réponse de `POST …/health/validate`
  erreur: null,        // le refus de la validation, avec sa raison
  chargement: false,
  test: null,          // { ok, detail, latency_ms } — le résultat d'un « Tester », qui n'écrit rien
  essai: false,        // un test est en cours
  busy: false,
  refusal: null,
  confirmingRetrait: null,   // le nom de la sonde dont le retrait attend confirmation
  refusGeste: null,
  // SPK-190 · SPK-DS-56 : « Ajouter les sondes standards » — un envoi en cours, et ce que le serveur a RENDU.
  busyStandard: false,
  resultatStandard: null,    // { added: [noms], present: [noms] } — relu du serveur, jamais l'espéré
};

// --- les valeurs de la modale ---------------------------------------------------------------------

/** Le texte saisi → le corps de `PUT` / `validate` / `test`. La cible HTTPS est COMPOSÉE, jamais saisie en entier. */
export function definitionDe(values) {
  const http = values.kind === 'http';
  const route = String(values.route ?? '').trim();
  const chemin = String(values.chemin ?? '/').trim() || '/';
  const entier = (t) => (/^\d+$/.test(String(t ?? '').trim()) ? Number(String(t).trim()) : String(t ?? '').trim());
  return {
    kind: values.kind,
    target: http ? `https://${route}${chemin.startsWith('/') ? chemin : `/${chemin}`}` : String(values.commande ?? '').trim(),
    expected: entier(values.expected),
    schedule: String(values.schedule ?? '').trim(),
    threshold: entier(values.threshold),
  };
}

/** Les valeurs de la modale, depuis la sonde AFFICHÉE : jamais des champs vides. */
export function valeursDeSonde(sonde, routes = []) {
  if (!sonde) {
    const premiere = routes.find((r) => r.tls && !String(r.domain).includes('*'));
    return { ...SANTE_VIDE.values, route: premiere?.domain ?? '' };
  }
  const base = { name: sonde.name, kind: sonde.kind, expected: String(sonde.expected),
                 schedule: sonde.schedule, threshold: String(sonde.threshold),
                 route: '', chemin: '/', commande: '' };
  if (sonde.kind === 'script') return { ...base, commande: sonde.target };
  try {
    const url = new URL(sonde.target);
    return { ...base, route: url.hostname, chemin: `${url.pathname}${url.search}` };
  } catch {
    return { ...base, route: '', chemin: '/' };
  }
}

/** Les routes qu'une sonde HTTPS peut viser : servies en TLS, jamais un joker (DAT §75.3). */
export const routesSondables = (routes = []) =>
  routes.filter((r) => r.tls && !String(r.domain).includes('*'));

// --- les états --------------------------------------------------------------------------------------

export const ETATS_SANTE = {
  unknown: { jeton: 'neutral', libelle: 'Jamais relevée' },
  healthy: { jeton: 'success', libelle: 'Saine' },
  unstable: { jeton: 'accent', libelle: 'Instable' },
  down: { jeton: 'danger', libelle: 'En panne' },
  stopped: { jeton: 'neutral', libelle: 'Arrêtée' },
};

function pastille(etat) {
  const { jeton, libelle } = ETATS_SANTE[etat] ?? ETATS_SANTE.unknown;
  return `<span class="badge badge--${jeton}"><span class="badge__point" aria-hidden="true"></span>${libelle}</span>`;
}

/**
 * La frise des derniers relevés : un rond PLEIN pour un succès, une CROIX pour un échec — la forme
 * porte ce que la couleur dit déjà (§1.5) — et un équivalent textuel.
 */
export function renderFrise(results = []) {
  if (!results.length) return '';
  const reussis = results.filter((r) => r.ok).length;
  const texte = `${reussis} relevé${reussis > 1 ? 's' : ''} réussi${reussis > 1 ? 's' : ''} sur les ${results.length} derniers`;
  const reperes = results.map((r, i) => {
    const x = i * 14 + 7;
    return r.ok
      ? `<circle class="frise__ok" cx="${x}" cy="10" r="5"/>`
      : `<path class="frise__echec" d="M${x - 4} 6 L${x + 4} 14 M${x + 4} 6 L${x - 4} 14"/>`;
  }).join('');
  return `<svg class="frise" width="${results.length * 14}" height="20" viewBox="0 0 ${results.length * 14} 20"
    role="img" aria-label="${echapper(texte)}">${reperes}</svg><span class="frise__texte">${echapper(texte)}</span>`;
}

// --- la zone d'aperçu : phrase, prochains relevés, refus -----------------------------------------------

export function renderZoneApercu(ui) {
  if (ui.erreur) return `<p class="refus" role="alert"><strong>${echapper(ui.erreur)}</strong></p>`;
  const a = ui.apercu;
  if (!a) {
    return `<p class="note">${ui.chargement ? 'Vérification…' : 'Complétez la sonde.'}</p>`;
  }
  const prises = (a.next_runs ?? []).map((iso) => `<li class="technique">${echapper(dateUtc(iso))}</li>`).join('');
  return `<p id="sante-phrase"><strong>${echapper(a.description)}</strong></p>`
    + (prises ? `<p class="note">Prochains relevés :</p><ul class="liste-simple">${prises}</ul>` : '');
}

/** Le résultat d'un « Tester » : un essai n'est pas un relevé, et la zone le dit. */
export function renderZoneTest(ui) {
  if (ui.essai) return '<p class="note" role="status">Essai en cours…</p>';
  if (!ui.test) return '';
  const t = ui.test;
  const latence = t.latency_ms != null ? ` · ${t.latency_ms} ms` : '';
  return t.ok
    ? `<p class="succes" role="status"><strong>L’essai a réussi</strong>${echapper(latence)}. Rien n’a été enregistré.</p>`
    : `<p class="refus" role="status"><strong>L’essai a échoué</strong> : ${echapper(t.detail ?? 'sans motif')}${echapper(latence)}.
       Rien n’a été enregistré, et aucune alerte n’est partie.</p>`;
}

// --- la modale ----------------------------------------------------------------------------------------------

const COMPTE_SCRIPT = 'Le script s’exécute dans la cellule, sous le compte de la pile (root, ou le compte '
  + 'rootless qui possède Docker), sans les variables de la pile, au plus 60 secondes. Seul son code de '
  + 'sortie compte : sa sortie n’est ni gardée ni envoyée.';

function renderModaleSante(ui, routes) {
  const v = ui.values;
  const choisi = presetPour(v.schedule);
  const sondables = routesSondables(routes);
  const http = v.kind === 'http';
  const modification = typeof ui.open === 'string' && ui.open !== 'neuve';
  return renderModale({
    ouverte: Boolean(ui.open), id: 'sante', titre: 'Santé',
    engagement: modification ? 'Enregistrer la sonde' : 'Ajouter la sonde',
    occupee: ui.busy, desactivee: Boolean(ui.erreur) || !ui.apercu, refus: ui.refusal,
    corps: `
      <div class="champ">
        <label for="sante-name">Nom</label>
        <input class="controle technique" id="sante-name" name="name" type="text" autocomplete="off"
               spellcheck="false" value="${echapper(v.name)}"${modification ? ' readonly' : ''}
               aria-describedby="sante-name-aide">
        <p class="champ__aide" id="sante-name-aide">${modification
          ? 'Le nom d’une sonde ne change pas : retirez-la et posez-en une autre.'
          : 'Minuscules, chiffres et tirets.'}</p>
      </div>
      <div class="champ">
        <label for="sante-kind">Type</label>
        <select class="controle" id="sante-kind" name="kind">
          <option value="http"${http ? ' selected' : ''}>HTTPS — une route du Spark</option>
          <option value="script"${http ? '' : ' selected'}>Script — dans la cellule</option>
        </select>
      </div>
      <div class="champ" data-sante-groupe="http"${http ? '' : ' hidden'}>
        <label for="sante-route">Route du Spark</label>
        ${sondables.length
          ? `<select class="controle technique" id="sante-route" name="route">${sondables.map((r) =>
              `<option value="${echapper(r.domain)}"${v.route === r.domain ? ' selected' : ''}>${echapper(r.domain)}</option>`).join('')}</select>
             <p class="champ__aide">Une sonde ne peut viser qu’un domaine de ce Spark, servi en TLS : il se choisit, il ne se saisit pas.</p>`
          : `<p class="absence" id="sante-route">Ce Spark n’a aucune route servie en TLS : il n’y a rien à sonder en HTTPS. Déclarez une route, ou sondez par un script.</p>`}
        <label for="sante-chemin">Chemin</label>
        <input class="controle technique" id="sante-chemin" name="chemin" type="text" autocomplete="off"
               spellcheck="false" value="${echapper(v.chemin)}">
      </div>
      <div class="champ" data-sante-groupe="script"${http ? ' hidden' : ''}>
        <label for="sante-commande">Commande</label>
        <input class="controle technique" id="sante-commande" name="commande" type="text" autocomplete="off"
               spellcheck="false" value="${echapper(v.commande)}" aria-describedby="sante-commande-aide">
        <p class="champ__aide" id="sante-commande-aide">${COMPTE_SCRIPT}</p>
      </div>
      <div class="champ">
        <label for="sante-expected">${http ? 'Statut HTTP attendu' : 'Code de sortie attendu'}</label>
        <input class="controle" id="sante-expected" name="expected" type="text" inputmode="numeric"
               autocomplete="off" value="${echapper(v.expected)}">
      </div>
      <div class="champ">
        <label for="sante-preset">Cadence courante</label>
        <select class="controle" id="sante-preset" name="preset">
          ${PRESETS_SANTE.map((p) => `<option value="${echapper(p.schedule)}"${choisi === p.schedule ? ' selected' : ''}>${echapper(p.libelle)}</option>`).join('')}
          <option value="${PERSONNALISEE}"${choisi === PERSONNALISEE ? ' selected' : ''}>Personnalisée</option>
        </select>
      </div>
      <div class="champ">
        <label for="sante-schedule">Chaîne crontab (UTC)</label>
        <input class="controle technique" id="sante-schedule" name="schedule" type="text" autocomplete="off"
               spellcheck="false" value="${echapper(v.schedule)}" aria-describedby="sante-schedule-aide">
        <p class="champ__aide" id="sante-schedule-aide">Cinq champs. Deux relevés ne peuvent pas être espacés de moins de 5 minutes.</p>
      </div>
      <div class="champ">
        <label for="sante-threshold">Seuil d’échecs</label>
        <input class="controle" id="sante-threshold" name="threshold" type="text" inputmode="numeric"
               autocomplete="off" value="${echapper(v.threshold)}" aria-describedby="sante-threshold-aide">
        <p class="champ__aide" id="sante-threshold-aide">Nombre d’échecs consécutifs avant l’alerte (1 à 20).</p>
      </div>
      <div id="sante-apercu" aria-live="polite">${renderZoneApercu(ui)}</div>
      <p><button type="button" class="bouton bouton--compact" data-sante-tester${
        ui.erreur || !ui.apercu || ui.essai ? ' disabled' : ''}>Tester</button></p>
      <div id="sante-test" aria-live="polite">${renderZoneTest(ui)}</div>`,
  });
}

// --- la liste --------------------------------------------------------------------------------------------------------

function renderSonde(s, ui) {
  const type = s.kind === 'http' ? 'HTTPS' : 'Script';
  // Instable : « 2 échecs sur 3 » — la jauge vers le seuil. En panne, le compteur CONTINUE au-delà du
  // seuil : « 13 échecs sur 1 » serait absurde, on dit donc « 13 échecs consécutifs · seuil 1 ».
  const n = s.consecutive_failures;
  const pluriel = n > 1 ? 's' : '';
  const echecs = s.state === 'unstable'
    ? ` — ${n} échec${pluriel} sur ${s.threshold}`
    : s.state === 'down'
      ? ` — ${n} échec${pluriel} consécutif${pluriel} · seuil ${s.threshold}` : '';
  const suspendue = s.enabled ? '' : ' <span class="badge badge--neutral">Suspendue</span>';
  const releve = s.last_run_at
    ? `Dernier relevé ${echapper(dateUtc(s.last_run_at))}${s.last_latency_ms != null ? ` · ${s.last_latency_ms} ms` : ''}`
    : 'Aucun relevé pour l’instant.';
  const depuis = s.state_since && s.state !== 'unknown' ? ` · depuis ${echapper(dateUtc(s.state_since))}` : '';
  const motif = s.last_detail && s.state !== 'healthy'
    ? `<p class="note">Motif : ${echapper(s.last_detail)}</p>` : '';
  const retrait = ui.confirmingRetrait === s.name
    ? `<div class="confirmation" role="group" aria-label="Confirmer le retrait de la sonde">
         <p><strong>Retirer la sonde « ${echapper(s.name)} » ?</strong></p>
         <p class="confirmation__consequence">Son historique disparaît avec elle. Rien d’autre n’est touché.</p>
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif" data-sante-confirme-retrait="${echapper(s.name)}">Retirer la sonde</button>
           <button type="button" class="bouton" data-sante-annule-retrait>Annuler</button>
         </p>
       </div>`
    : '';
  const cible = s.kind === 'script'
    ? `<p class="note">Commande exécutée dans la cellule : <span class="technique">${echapper(s.target)}</span></p>`
    : `<p class="note"><span class="technique">${echapper(s.target)}</span> · statut attendu ${s.expected}</p>`;
  return `<li data-sante-sonde="${echapper(s.name)}">
    <span class="technique">${echapper(s.name)}</span> <span class="absence">${type}</span>
    ${pastille(s.state)}${suspendue}<span class="absence">${echapper(echecs)}</span>
    <span class="actions-ligne">
      <button type="button" class="bouton bouton--compact" data-sante-modifie="${echapper(s.name)}"
        aria-label="Modifier la sonde ${echapper(s.name)}">Modifier</button>
      <button type="button" class="bouton bouton--compact" data-sante-bascule="${s.enabled ? 'suspend' : 'resume'}"
        data-sonde="${echapper(s.name)}" aria-label="${s.enabled ? 'Suspendre' : 'Reprendre'} la sonde ${echapper(s.name)}">${s.enabled ? 'Suspendre' : 'Reprendre'}</button>
      <button type="button" class="bouton bouton--compact" data-sante-retrait="${echapper(s.name)}"
        aria-label="Retirer la sonde ${echapper(s.name)}">Retirer</button>
    </span>
    <div class="sonde__corps">
      ${cible}
      <p class="note">${releve}${depuis} · ${echapper(s.description)}</p>
      ${motif}
      <p class="frise-ligne">${renderFrise(s.results)}</p>
      ${retrait}
    </div></li>`;
}

// --- SPK-190 · les sondes standards (DAT §77, SPK-DS-56) -------------------------------------------------------------------

const cadenceClaire = (chaine) => PRESETS_SANTE.find((p) => p.schedule === chaine)?.libelle ?? chaine;
const nSondes = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
const liste = (noms) => noms.map(echapper).join(', ');

/** La phrase du geste, RELUE du serveur : ce qui a été ajouté, et ce qui était déjà là et n'a pas été touché. */
function renderResultatStandard(r) {
  if (!r?.added?.length) return '';
  const deja = r.present?.length ? ` Déjà posées, laissées telles quelles : ${liste(r.present)}.` : '';
  return `<p class="succes" role="status" tabindex="-1" data-sante-standard-resultat><strong>${
    nSondes(r.added.length, 'sonde standard ajoutée', 'sondes standards ajoutées')}</strong> : ${
    liste(r.added)}.${deja}</p>`;
}

/**
 * Les sondes standards : le bouton, ce qu'il pose (commande EXACTE comprise, DAT §75.5), ce qui est indisponible.
 * `standard` vaut `null` quand la lecture a échoué : aucun bouton — une commande dont on ne sait rien ne se propose pas.
 */
function renderStandard(standard, ui) {
  const phrase = renderResultatStandard(ui.resultatStandard);
  if (!standard) return { bouton: '', corps: phrase };
  const aAjouter = standard.to_add ?? [];
  const indispo = (standard.unavailable ?? []).map((u) =>
    `<p class="note"><span class="technique">${echapper(u.name)}</span> : ${echapper(u.reason)}</p>`).join('');
  if (!aAjouter.length) {
    const toutes = standard.unavailable?.length ? 'Toutes les sondes standards disponibles sont posées.'
      : 'Les sondes standards sont toutes posées.';
    return { bouton: '', corps: `${phrase}<p class="note">${toutes}</p>${indispo}` };
  }
  const lignes = aAjouter.map((s) => `
      <li><span class="technique">${echapper(s.name)}</span> — ${echapper(s.description)}
        <span class="std-regle note">${echapper(cadenceClaire(s.schedule))}, alerte après ${nSondes(s.threshold, 'échec consécutif', 'échecs consécutifs')}.</span>
        <span class="technique commande">${echapper(s.target)}</span></li>`).join('');
  return {
    bouton: `<button type="button" class="bouton" data-sante-standard${ui.busyStandard ? ' disabled' : ''}>Ajouter les sondes standards (${aAjouter.length})</button>`,
    corps: `${phrase}
  <details class="repli"><summary>Ce que les sondes standards vont poser</summary>
    <ul class="std-liste">${lignes}</ul>
    <p class="note">Chaque commande s’exécute dans la cellule, sous le compte de la pile, à chaque relevé. Aucune n’écrit rien.</p>
  </details>${indispo}`,
  };
}

/**
 * La facette Santé (SPK-DS-51). `health` vaut `null` quand sa lecture a échoué : l'écran le dit, il ne
 * montre pas une absence de sonde (§14.6). `canal` : `true` / `false` / `null` (illisible).
 */
export function renderSanteFacette(health, ui = SANTE_VIDE, { routes = [], canal = null, standard = null } = {}) {
  let corps;
  if (health == null) {
    corps = '<p class="absence" role="status">Les sondes n’ont pas pu être lues : rien ne dit si ce Spark est surveillé.</p>';
  } else if (!health.checks.length) {
    corps = `<p class="absence">Aucune sonde : rien ne surveille ce Spark.</p>`;
  } else {
    corps = `<ul class="liste-administrable">${health.checks.map((s) => renderSonde(s, ui)).join('')}</ul>`;
  }
  const std = renderStandard(standard, ui);
  const alerte = canal === false
    ? `<p class="avertissement" role="status">Aucun canal d’alerte n’est configuré : une panne ne se verra qu’ici.
       <a href="#/forge/alertes">Configurer les alertes de la Forge</a></p>`
    : canal === null
      ? '<p class="avertissement" role="status">Le canal d’alerte n’a pas pu être lu : on ne sait pas si une panne serait annoncée.</p>' : '';
  return `
<section class="carte bloc" aria-labelledby="titre-sante">
  <h2 id="titre-sante">Santé</h2>
  ${alerte}
  ${ui.refusGeste ? `<div class="refus" role="alert"><p><strong>${echapper(ui.refusGeste)}</strong></p></div>` : ''}
  ${corps}
  <p class="actions-section"><button type="button" class="bouton" data-ouvre="sante">Ajouter une sonde</button>
    ${std.bouton}</p>
  ${std.corps}
  ${renderModaleSante(ui, routes)}
  <p class="note">Une sonde HTTPS part de la Forge et ne peut viser qu’un domaine de ce Spark ; un script
  s’exécute dans la cellule. L’alerte part à la panne, une fois, puis au rétablissement. Un relevé de
  sonde ne vérifie pas le DNS.</p>
</section>`;
}
