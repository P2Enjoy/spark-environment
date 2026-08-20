/**
 * L'onglet Docker d'un Spark, en lecture seule.
 *
 * @spec docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6 (l'onglet en lecture),
 *       §37.6 bis (le contrat) · docs/DESIGN_SYSTEM_APP.md SPK-DS-05 (deux
 *       origines de mesure ne partagent pas une jauge) ·
 *       docs/DESIGN_SYSTEM.md §6.14 (tableau), §6.13 (états d'une vue),
 *       §14.5 (nommer une absence), §14.6, §14.7, §1.4 (pas de commande morte)
 *
 * **Aucun bouton d'action.** SPK-44 est en lecture ; les gestes sur un conteneur
 * sont l'objet de SPK-45. Un bouton posé ici laisserait croire que cet onglet
 * peut agir, et le §1.4 interdit d'afficher une commande qui n'existe pas.
 *
 * SPK-DS-05 : les mesures affichées viennent de Docker, **à l'intérieur** de la
 * cellule, et se comparent à ce que la cellule voit d'elle-même. Elles ne sont
 * jamais mises dans la même jauge que celles du Spark, qui viennent du runtime
 * et se comparent à ses quotas. Chacune est donc écrite avec son référentiel.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** État de l'écran. `null` tant que rien n'a été relevé. */
export const DOCKER_VIDE = {
  status: 'chargement',   // 'chargement' | 'pret' | 'erreur'
  releve: null,           // { state, containers, titre, detail }
  erreur: null,
  // §37.6 ter : l'inspection et les journaux sont DEMANDÉS. `null` tant qu'on
  // n'a ouvert aucun conteneur — la sortie peut peser des mégaoctets, et
  // personne ne lit dix journaux à la fois.
  ouvert: null,           // le nom du conteneur ouvert
  detail: null,           // 'en-cours' | l'inspection rendue
  journaux: null,         // 'en-cours' | { lines, truncated, tail }
};

/** L'état d'un conteneur, dit en français (§14.7). */
const ETATS_CONTENEUR = {
  running: { libelle: 'en marche', token: 'success' },
  exited: { libelle: 'arrêté', token: 'neutral' },
  created: { libelle: 'créé', token: 'neutral' },
  paused: { libelle: 'en pause', token: 'accent' },
  restarting: { libelle: 'redémarre', token: 'accent' },
  dead: { libelle: 'mort', token: 'danger' },
};

function ligneConteneur(c) {
  const etat = ETATS_CONTENEUR[c.state] ?? { libelle: c.state || 'inconnu', token: 'neutral' };
  // §14.6 : une mesure absente ne devient pas zéro. Elle se NOMME.
  const cpu = c.cpu ?? null;
  const memoire = c.memory ?? null;
  return `<tr>
    <td><strong>${echapper(c.name)}</strong>
      <span class="technique" title="${echapper(c.image)}">${echapper(c.image)}</span></td>
    <td><span class="badge badge--${etat.token}">${echapper(etat.libelle)}</span>
      <span class="note">${echapper(c.status)}</span></td>
    <td>${cpu ? `<span class="technique">${echapper(cpu)}</span>`
      : '<span class="absence-cellule">non mesuré</span>'}</td>
    <td>${memoire ? `<span class="technique">${echapper(memoire)}</span>`
      : '<span class="absence-cellule">non mesuré</span>'}</td>
    <td>${c.ports
      ? `<span class="technique">${echapper(c.ports)}</span>`
      : ''}</td>
    <td><button type="button" class="bouton bouton--compact"
                data-docker="ouvrir" data-conteneur="${echapper(c.name)}">
      Inspecter</button></td>
  </tr>`;
}

export function renderDocker(spark, etat = DOCKER_VIDE) {
  if (!spark) return '';

  // §5.4, point 2 : une surface a UN sujet. Le conteneur ouvert remplace la
  // liste plutôt que de s'empiler dessous — sinon l'écran en porte deux, et on
  // ne sait plus lequel fait foi.
  if (etat.ouvert) return renderConteneur(etat);

  const entete = `<h2 id="titre-docker">Docker</h2>`;

  if (etat.status === 'chargement') {
    return `
<section class="carte bloc" aria-labelledby="titre-docker">
  ${entete}
  <p class="note" role="status" aria-busy="true">Lecture de ce qui tourne dans ce Spark…</p>
</section>`;
  }

  if (etat.status === 'erreur') {
    return `
<section class="carte bloc" aria-labelledby="titre-docker">
  ${entete}
  <div class="refus" role="alert"><p>${echapper(etat.erreur ?? '')}</p></div>
</section>`;
  }

  const releve = etat.releve;
  const conteneurs = releve?.containers ?? [];

  // §6.13 et §14.5 : chaque absence est NOMMÉE, aucune n'est rendue par un
  // tableau vide. Un tableau sans ligne ne dit pas si Docker manque, si son
  // moteur est muet, ou s'il n'y a simplement rien à montrer.
  if (!conteneurs.length) {
    return `
<section class="carte bloc" aria-labelledby="titre-docker">
  ${entete}
  <p class="absence"><strong>${echapper(releve?.titre ?? 'Rien à afficher')}</strong></p>
  <p class="note">${echapper(releve?.detail ?? '')}</p>
</section>`;
  }

  return `
<section class="carte bloc" aria-labelledby="titre-docker">
  ${entete}
  <p class="note">Ce que Docker rapporte <strong>depuis l’intérieur</strong> de la
  cellule. Ces mesures se comparent à ce que la cellule voit d’elle-même, jamais
  aux quotas du Spark — ce sont deux référentiels différents.</p>
  <div class="table-defilante">
    <table>
      <thead>
        <tr><th>Conteneur</th><th>État</th><th>Processeur</th><th>Mémoire</th>
            <th>Ports</th><th><span class="sr-only">Inspection</span></th></tr>
      </thead>
      <tbody>${conteneurs.map(ligneConteneur).join('')}</tbody>
    </table>
  </div>
  <p class="note">Relevé toutes les cinq secondes tant que cet onglet est ouvert,
  et <strong>arrêté</strong> dès que vous le quittez.</p>
</section>`;
}

/** L'état d'un conteneur ouvert, dit en français (§14.7). */
const ETATS_DETAIL = {
  running: 'en marche', exited: 'arrêté', created: 'créé',
  paused: 'en pause', restarting: 'redémarre', dead: 'mort',
};

function definitions(paires) {
  const lignes = paires.filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([cle, valeur, technique]) => `<div class="def"><dt>${echapper(cle)}</dt>
      <dd>${technique ? `<span class="technique">${echapper(valeur)}</span>`
        : echapper(valeur)}</dd></div>`);
  return lignes.length ? `<div class="definitions">${lignes.join('')}</div>` : '';
}

/**
 * Le conteneur ouvert : son identité, ses réseaux, ses montages, ses journaux.
 *
 * @spec docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6 ter ·
 *       docs/DESIGN_SYSTEM.md §6.13, §14.5, §14.6, §6.27
 */
export function renderConteneur(etat) {
  if (!etat.ouvert) return '';

  const fermer = `<p class="formulaire__actions">
    <button type="button" class="bouton bouton--compact" data-docker="fermer">
      Revenir à la liste</button>
    <button type="button" class="bouton bouton--compact" data-docker="relire"
            data-conteneur="${echapper(etat.ouvert)}">Relire les journaux</button>
  </p>`;

  const d = etat.detail;
  const identite = d === 'en-cours' || d === null
    ? '<p class="note" role="status" aria-busy="true">Inspection en cours…</p>'
    : d.state === 'conteneur_inconnu' || d.titre
      ? `<div class="refus" role="alert">
           <p><strong>${echapper(d.titre ?? '')}</strong></p>
           <p>${echapper(d.detail ?? '')}</p>
         </div>`
      : definitions([
          ['État', ETATS_DETAIL[d.state] ?? d.state],
          // §14.6 : le code de sortie n'existe que pour un conteneur arrêté.
          ['Code de sortie', d.exitCode === null || d.exitCode === undefined
            ? null : String(d.exitCode), true],
          ['Image', d.image, true],
          ['Démarré', d.startedAt, true],
          ['Terminé', d.finishedAt, true],
          ['Redémarrages', d.restarts ? String(d.restarts) : null],
        ])
        + (d.networks === null
          ? '<p class="note">Réseaux : non lus.</p>'
          : d.networks?.length
            ? `<p class="note">Réseaux — ${d.networks.map((r) =>
                `<span class="technique">${echapper(r.name)}</span>${
                  r.address ? ` (${echapper(r.address)})` : ''}`).join(', ')}</p>`
            : '<p class="note">Aucun réseau attaché.</p>')
        + (d.mounts === null
          ? '<p class="note">Montages : non lus.</p>'
          : d.mounts?.length
            ? `<ul class="note">${d.mounts.map((m) =>
                `<li><span class="technique">${echapper(m.source)}</span> →
                 <span class="technique">${echapper(m.destination)}</span>
                 (${echapper(m.type)}, ${echapper(m.mode)})</li>`).join('')}</ul>`
            : '<p class="note">Aucun volume monté.</p>');

  const j = etat.journaux;
  const journaux = j === 'en-cours' || j === null
    ? '<p class="note" role="status" aria-busy="true">Lecture des journaux…</p>'
    : j.state === 'conteneur_inconnu'
      ? ''
      : `${j.truncated
        ? `<p class="note">Les <strong>${echapper(j.tail)} dernières lignes</strong>,
           pas le journal entier — un conteneur bavard rendrait l’écran inutilisable.</p>`
        : `<p class="note">${echapper(j.lines?.length ?? 0)} ligne(s), soit tout ce que
           ce conteneur a écrit depuis son démarrage.</p>`}
      <p class="note"><strong>Ce texte vient du locataire</strong> et n’a été ni relu
      ni caviardé : il peut contenir ce qu’il y a écrit, y compris un secret.</p>
      ${j.lines?.length
        ? `<pre class="terminal" tabindex="0" role="region"
                aria-label="Journaux de ${echapper(etat.ouvert)}">${j.lines.map((l) =>
             `${l.at ? `${echapper(l.at)} ` : ''}${echapper(l.text)}`).join('\n')}</pre>`
        : '<p class="absence">Ce conteneur n’a rien écrit.</p>'}`;

  return `
<section class="carte bloc" aria-labelledby="titre-conteneur">
  <h2 id="titre-conteneur">${echapper(etat.ouvert)}</h2>
  ${identite}
  ${journaux}
  ${fermer}
</section>`;
}
