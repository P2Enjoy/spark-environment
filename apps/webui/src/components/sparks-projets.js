/**
 * Les projets : ranger les Sparks, sans rien leur faire.
 *
 * @spec docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.1 (une étiquette : supprimer un
 *       projet désaffecte, ne touche aucun Spark), §61.4 (l'écran : Tous, un
 *       onglet par projet, Projets ; ranger depuis la fenêtre du Spark) ·
 *       docs/DESIGN_SYSTEM.md §5.2 (des destinations, donc des liens), §6.8
 *       (pastilles neutres), §6.10 (cases), §6.19 (liste administrable), §6.22,
 *       §6.23 (supprimer se confirme dans le flux), §6.27 (une modale par
 *       section ; celle qui ne recueille rien n'offre pas de l'engager), §14.5 ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-33 · docs/MANUAL_PLAN.md M3, M8
 *
 * Les adresses portent un `~` : un nom de Spark ne peut pas en contenir
 * (`[a-z0-9-]`), et `#/sparks/projets` aurait masqué la fenêtre d'un Spark
 * nommé « projets » (DAT §61.4).
 */

import { renderModale } from './modale.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const ADRESSE_GESTION = '#/sparks/~projets';
export const adresseProjet = (id) => `#/sparks/~projet/${encodeURIComponent(id)}`;

/** Longueur du nom, la même que le serveur (§61.2) : une aide, pas l'autorité. */
export const LONGUEUR_NOM = 40;

/** État de la page de gestion. `confirming` : l'id du projet à supprimer. */
export const PROJETS_UI_VIDE = {
  open: null, cible: null, nom: '', refusal: null, busy: false,
  confirming: null, issue: null,
};

/**
 * La rangée du second degré de *Sparks* : Tous, un onglet par projet dans
 * l'ordre alphabétique que rend le serveur, puis Projets (SPK-DS-33).
 */
export function ongletsSparks(projets = []) {
  return [['#/sparks', 'Tous'],
          ...(projets ?? []).map((p) => [adresseProjet(p.id), p.name]),
          [ADRESSE_GESTION, 'Projets']];
}

/** Les projets d'un Spark, en pastilles NEUTRES : une catégorie, pas un état (§6.8). */
export function renderPastillesProjets(projets = []) {
  if (!projets?.length) return '';
  return `<span class="pastilles-projets">${projets.map((p) =>
    `<span class="badge badge--neutral">${echapper(p.name)}</span>`).join('')}</span>`;
}

/**
 * La page *Projets* : la liste, et ses trois gestes.
 *
 * `projets` : `undefined` pendant la lecture, `null` si elle a échoué.
 */
export function renderProjetsGestion(projets, ui = PROJETS_UI_VIDE) {
  let corps;
  if (projets === undefined) {
    corps = '<p class="note" role="status" aria-busy="true">Lecture des projets…</p>';
  } else if (projets === null) {
    corps = `<div class="refus" role="alert"><p><strong>${
      echapper(ui.refusal?.liste ?? 'Les projets n’ont pas pu être lus.')}</strong></p></div>`;
  } else if (!projets.length) {
    corps = '<p class="absence">Aucun projet. Tous les Sparks se lisent dans l’onglet <em>Tous</em>.</p>';
  } else {
    corps = `<ul class="liste-administrable">${projets.map((p) => {
      const sparks = p.sparks?.length
        ? `Sparks : ${p.sparks.map((s) =>
            `<a class="lien-spark" href="#/sparks/${encodeURIComponent(s)}">${echapper(s)}</a>`).join(', ')}`
        : 'aucun Spark';
      // §6.23 : le projet disparaît, donc bouton destructif ; la confirmation
      // NOMME les Sparks désaffectés et dit qu'ils ne sont pas modifiés (§61.1).
      const confirme = ui.confirming === p.id
        ? `<div class="confirmation" role="group" aria-label="Confirmer la suppression du projet">
             <p><strong>Supprimer le projet « ${echapper(p.name)} » ?</strong></p>
             <p class="confirmation__consequence">${p.sparks?.length
               ? `${p.sparks.length > 1 ? 'Ces Sparks sont désaffectés' : 'Ce Spark est désaffecté'} : ${
                   p.sparks.map((s) => `<span class="technique">${echapper(s)}</span>`).join(', ')}.
                  Ils ne sont pas modifiés : seul le rangement disparaît.`
               : 'Aucun Spark n’y est rangé.'}</p>
             <p class="confirmation__actions">
               <button type="button" class="bouton bouton--destructif" data-confirme-suppression-projet="${
                 echapper(p.id)}">Supprimer le projet</button>
               <button type="button" class="bouton" data-annule-projet="${echapper(p.id)}">Annuler</button>
             </p>
           </div>`
        : '';
      return `<li><span><a class="lien-spark" href="${adresseProjet(p.id)}">${echapper(p.name)}</a></span>
        <span class="actions-ligne">
          <button type="button" class="bouton bouton--compact" data-renomme-projet="${
            echapper(p.id)}">Renommer</button>
          <button type="button" class="bouton bouton--compact" data-supprime-projet="${
            echapper(p.id)}">Supprimer</button>
        </span>
        <span class="membres">${sparks}</span>${confirme}</li>`;
    }).join('')}</ul>`;
  }

  const issue = ui.issue
    ? `<div class="succes" role="status"><p>${echapper(ui.issue)}</p></div>` : '';
  const refus = ui.refusal?.liste && projets
    ? `<div class="refus" role="alert"><p>${echapper(ui.refusal.liste)}</p></div>` : '';

  const cible = (projets ?? []).find((p) => p.id === ui.cible);
  const modale = renderModale({
    ouverte: ui.open === 'projet-creation' || ui.open === 'projet-renommage',
    id: ui.open ?? 'projet-creation',
    titre: ui.open === 'projet-renommage'
      ? `Renommer « ${cible?.name ?? ''} »` : 'Créer un projet',
    engagement: ui.open === 'projet-renommage' ? 'Renommer le projet' : 'Créer le projet',
    refus: ui.refusal?.modale ?? null,
    occupee: ui.busy,
    corps: `
      <div class="champ">
        <label for="projet-nom">Nom du projet</label>
        <input class="controle" id="projet-nom" name="nom" type="text" autocomplete="off"
               maxlength="${LONGUEUR_NOM}" value="${echapper(ui.nom)}"
               aria-describedby="projet-nom-aide">
        <p class="champ__aide" id="projet-nom-aide">De 1 à ${LONGUEUR_NOM} caractères. Deux projets
        ne peuvent pas porter le même nom, majuscules comprises.</p>
      </div>`,
  });

  return `
<div class="titre-vue">
  <h1>Projets</h1>
  <p class="titre-vue__compte">${projets?.length ?? 0} projet${(projets?.length ?? 0) > 1 ? 's' : ''}</p>
</div>
<section class="carte bloc" aria-labelledby="titre-projets">
  <h2 id="titre-projets">Ranger les Sparks</h2>
  <p class="note">Un projet range des Sparks, et ne leur fait rien : ni quota, ni accès, ni
  réseau. Un Spark peut appartenir à plusieurs projets ; on le range depuis sa fenêtre,
  onglet <em>Infos</em>. <a href="#/manuel/M3">Manuel M3 — Ranger les Sparks en projets</a></p>
  ${issue}
  ${corps}
  ${refus}
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre="projet-creation"
      ${ui.busy || projets === undefined ? 'disabled' : ''}>Créer un projet</button>
  </p>
  ${modale}
</section>`;
}

/**
 * La section *Projets* de la facette *Infos* : à quoi ce Spark appartient, et
 * *Modifier* — une modale à cases, une par projet (§61.4, SPK-DS-33).
 *
 * Aucun `disabled` pour un Spark protégé : ranger n'atteint pas le Spark
 * (§61.1), et le serveur ne lit pas la protection pour ce geste.
 *
 * `tous` : les projets de la Forge, `null` s'ils n'ont pas pu être lus.
 */
export function renderProjetsSpark(spark, tous, admin = {}) {
  const siens = spark?.projects ?? [];
  const valeurs = admin.values ?? {};
  const coche = (p) => valeurs[`projet:${p.id}`] ?? siens.some((s) => s.id === p.id);
  const ouverte = admin.open === 'projets';
  const refusDansModale = admin.refusal?.panel === 'projets' ? admin.refusal.message : null;
  const modale = renderModale({
    ouverte, id: 'projets', titre: 'Projets',
    // §6.27 : sans projet, la modale ne recueille rien — elle explique, et son
    // bouton dit « Fermer ».
    engagement: tous?.length ? 'Enregistrer le rangement' : null,
    refus: refusDansModale, occupee: admin.busy,
    corps: tous === null
      ? '<p class="avertissement" role="status">Les projets de la Forge n’ont pas pu être lus.</p>'
      : tous?.length
        ? `<fieldset class="cases">
             <legend>Projets de « ${echapper(spark.name)} »</legend>
             ${tous.map((p) => `<label class="case">
               <input type="checkbox" name="projet:${echapper(p.id)}"${coche(p) ? ' checked' : ''}>
               <span>${echapper(p.name)}</span></label>`).join('')}
           </fieldset>
           <p class="champ__aide">Cocher range le Spark ; décocher le retire du projet. Le Spark
           n’est pas modifié.</p>`
        : `<p class="absence">Aucun projet n’existe encore. Créez-en un depuis l’onglet
           <a href="${ADRESSE_GESTION}">Projets</a> de la liste des Sparks.</p>`,
  });
  return `
<section class="carte bloc" aria-labelledby="titre-projets-spark">
  <h2 id="titre-projets-spark">Projets</h2>
  ${siens.length
    ? `<p>${renderPastillesProjets(siens)}</p>`
    : '<p class="absence">Ce Spark n’est rangé dans aucun projet.</p>'}
  ${admin.refusal?.panel === 'projets' && !ouverte
    ? `<div class="refus" role="alert"><p>${echapper(admin.refusal.message)}</p></div>` : ''}
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre="projets">Modifier</button>
  </p>
  ${modale}
</section>`;
}

/** Les identifiants cochés dans la modale, tels qu'ils partiront au serveur. */
export function projetsCoches(spark, tous, valeurs = {}) {
  const siens = new Set((spark?.projects ?? []).map((p) => p.id));
  return (tous ?? []).filter((p) => valeurs[`projet:${p.id}`] ?? siens.has(p.id)).map((p) => p.id);
}

/**
 * L'onglet d'un projet est la liste de *Tous*, restreinte (SPK-DS-33). Rend le
 * sous-ensemble, et ce qu'il faut dire quand il est vide ou que le projet
 * n'existe plus (§14.5).
 */
export function filtrerParProjet(sparks = [], projets = [], id = null) {
  if (!id) return { sparks, projet: null, absent: false };
  const projet = (projets ?? []).find((p) => p.id === id) ?? null;
  if (!projet) return { sparks: [], projet: null, absent: true };
  return { sparks: sparks.filter((s) => (s.projects ?? []).some((p) => p.id === id)),
           projet, absent: false };
}
