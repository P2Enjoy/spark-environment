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
  </tr>`;
}

export function renderDocker(spark, etat = DOCKER_VIDE) {
  if (!spark) return '';

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
        <tr><th>Conteneur</th><th>État</th><th>Processeur</th><th>Mémoire</th><th>Ports</th></tr>
      </thead>
      <tbody>${conteneurs.map(ligneConteneur).join('')}</tbody>
    </table>
  </div>
  <p class="note">Relevé toutes les cinq secondes tant que cet onglet est ouvert,
  et <strong>arrêté</strong> dès que vous le quittez.</p>
</section>`;
}
