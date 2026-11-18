/**
 * Onglet « Mises à jour » de la Forge : ce que le système de la machine attend.
 *
 * @spec docs/BACKLOG.md#SPK-171 · docs/DAT.md §70.5 (ce qui est relevé, en
 *       lecture seule) · §70.6 (les pools ZFS à mettre à niveau, renvoyés à
 *       l'installation) · docs/DESIGN_SYSTEM.md §1.5 bis (l'écran nomme, le
 *       manuel explique), §5.4 (l'onglet ne porte aucune action), §6.4, §6.13
 *       (états de vue ; un relevé se date), §6.14, §14.5, §14.6 ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-46 · docs/manuel/M8-exploiter.md
 *
 * @spec docs/BACKLOG.md#SPK-181 · docs/DAT.md §73 (cases décochées, raccourcis,
 *       confirmation qui nomme les paquets, état de l'application) ·
 *       docs/DESIGN_SYSTEM.md §6.10, §6.22, §6.23, §9.7 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-18 (la sortie se replie), SPK-DS-46
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SYSTEME_VIDE = Object.freeze({
  status: 'loading', donnees: null, error: null,
  // SPK-181 · §73 : la sélection, la confirmation ouverte, l'envoi en cours, le
  // refus du serveur, et l'état de la dernière application.
  selection: [], confirmer: false, envoi: false, refus: null, application: null,
});

/** Même convention que le journal : la minute, telle que la Forge la date. */
const date = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');

const badge = (token, texte) =>
  `<span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${
    echapper(texte)}</span>`;

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

function entete(relire = true) {
  return `<header class="entete-entite">
  <div class="entete-entite__identite"><h1>Mises à jour</h1></div>
  ${relire ? `<p class="formulaire__actions"><button type="button" class="bouton"
    data-action="relire-systeme">Relire</button></p>` : ''}
</header>`;
}

/** Le résumé des paquets, puis leur table — la sécurité en tête (§70.5). */
/** Les raccourcis, le bouton d'application et sa confirmation (§73.1). */
function renderApplication(paquets, ui) {
  const selection = (ui.selection ?? []).filter((nom) => paquets.some((p) => p.nom === nom));
  const occupe = ui.application?.etat === 'en_cours' || ui.envoi;
  const securite = paquets.some((p) => p.securite);
  const raccourcis = `<p class="formulaire__actions">
    <button type="button" class="bouton bouton--compact" data-action="maj-tout"${occupe ? ' disabled' : ''}>Tout sélectionner</button>
    ${securite ? `<button type="button" class="bouton bouton--compact" data-action="maj-securite"${
      occupe ? ' disabled' : ''}>Sécurité seulement</button>` : ''}
    ${selection.length && !ui.confirmer ? `<button type="button" class="bouton bouton--primaire"
      data-action="maj-demander"${occupe ? ' disabled' : ''}>Appliquer les mises à jour sélectionnées (${
      selection.length})</button>` : ''}
  </p>`;
  const confirmation = ui.confirmer && selection.length ? `<div class="confirmation confirmation--sensible"
      role="group" aria-labelledby="titre-confirmation-maj">
      <p id="titre-confirmation-maj"><strong>Appliquer ${selection.length} mise${
        selection.length > 1 ? 's' : ''} à jour ?</strong></p>
      <ul>${selection.map((nom) => {
        const p = paquets.find((q) => q.nom === nom);
        return `<li><span class="technique">${echapper(nom)}</span> : ${echapper(p?.installee)} → ${
          echapper(p?.proposee)}</li>`;
      }).join('')}</ul>
      <p class="confirmation__consequence">Des services peuvent redémarrer pendant l’opération
        (Incus, Caddy, sshd) ; les Sparks continuent de tourner. La Forge n’est
        <strong>jamais</strong> redémarrée par ce geste.</p>
      ${ui.refus ? `<p class="refus" role="alert">${echapper(ui.refus)}</p>` : ''}
      <p class="confirmation__actions">
        <button type="button" class="bouton bouton--primaire" data-action="maj-confirmer"${
          ui.envoi ? ' disabled' : ''}>${ui.envoi ? 'Envoi…' : 'Appliquer'}</button>
        <button type="button" class="bouton" data-action="maj-annuler"${ui.envoi ? ' disabled' : ''}>Annuler</button>
      </p>
    </div>` : '';
  return raccourcis + confirmation;
}

/** L'état de la dernière application (§73.3). */
export function renderEtatApplication(application) {
  if (!application || application.etat === 'aucune') return '';
  const paquets = application.paquets ?? [];
  if (application.etat === 'en_cours') {
    return `<p class="avertissement" role="status" aria-busy="true">Application en cours :
      ${paquets.length} paquet${paquets.length > 1 ? 's' : ''}, depuis ${echapper(date(application.debut))}.</p>`;
  }
  const sortie = application.sortie
    ? `<details><summary>Sortie d’apt-get (${pluriel((application.sortie.match(/\n/g)?.length ?? 0) + 1,
      'dernière ligne', 'dernières lignes')})</summary>
       <pre class="technique">${echapper(application.sortie)}</pre></details>` : '';
  return application.etat === 'terminee'
    ? `<div class="succes" role="status"><p><strong>Mises à jour appliquées</strong> :
        ${paquets.map((p) => `<span class="technique">${echapper(p)}</span>`).join(', ')}
        (${echapper(date(application.fin))}).</p>${sortie}</div>`
    : `<div class="refus" role="alert"><p><strong>Application en échec</strong>, code
        ${echapper(application.code)} (${echapper(date(application.fin))}). Les paquets
        non mis à jour restent dans la liste.</p>${sortie}</div>`;
}

function renderPaquets(maj, ui = SYSTEME_VIDE) {
  const total = Number(maj?.total ?? 0);
  const securite = maj?.securite;
  const relue = maj?.liste_relue_a
    ? `Liste des paquets relue le <span class="technique">${echapper(date(maj.liste_relue_a))}</span>.`
    : 'Date de la liste des paquets inconnue.';
  if (total === 0) {
    return `<section class="carte bloc" aria-labelledby="titre-paquets">
  <h2 id="titre-paquets" tabindex="-1">Paquets</h2>
  <p>${badge('success', 'à jour')} Aucune mise à jour en attente.</p>
  <p class="note">${relue}</p>
  ${renderEtatApplication(ui.application)}
</section>`;
  }
  const resume = securite === null || securite === undefined
    ? `${pluriel(total, 'mise à jour en attente', 'mises à jour en attente')} — part de sécurité non relevée`
    : securite === 0
      ? `${pluriel(total, 'mise à jour en attente', 'mises à jour en attente')}, aucune de sécurité`
      : `${pluriel(total, 'mise à jour en attente', 'mises à jour en attente')}, dont ${
        pluriel(securite, 'de sécurité', 'de sécurité')}`;
  const paquets = maj?.paquets ?? [];
  const partiel = paquets.length < total
    ? `<p class="note">${paquets.length ? `Les ${paquets.length} premiers paquets sur ${total}.`
      : 'La liste détaillée n’a pas pu être lue ; seul le nombre est connu.'}</p>` : '';
  const selection = new Set(ui.selection ?? []);
  const occupe = ui.application?.etat === 'en_cours' || ui.envoi;
  const lignes = paquets.map((p) => `<tr>
      <td><label class="case"><input type="checkbox" data-paquet="${echapper(p.nom)}"${
        selection.has(p.nom) ? ' checked' : ''}${occupe ? ' disabled' : ''}>
        <span class="sr-only">Sélectionner ${echapper(p.nom)}</span></label></td>
      <td class="technique">${echapper(p.nom)}</td>
      <td>${p.securite ? badge('danger', 'sécurité') : '<span class="note">courante</span>'}</td>
      <td class="technique cellule-dense" title="${echapper(p.installee)}">${echapper(p.installee)}</td>
      <td class="technique cellule-dense" title="${echapper(p.proposee)}">${echapper(p.proposee)}</td>
      <td class="technique">${echapper(p.suite)}</td>
    </tr>`).join('');
  return `<section class="carte bloc" aria-labelledby="titre-paquets">
  <h2 id="titre-paquets" tabindex="-1">Paquets</h2>
  <p>${badge(securite ? 'danger' : 'accent', resume)}</p>
  <p class="note">${relue} Choisissez les paquets, puis appliquez-les
    (<a href="#/manuel/M8">manuel M8 — Mettre à jour le système</a>).</p>
  ${partiel}
  ${renderEtatApplication(ui.application)}
  ${paquets.length ? renderApplication(paquets, ui) : ''}
  ${paquets.length ? `<div class="tableau-enveloppe">
    <p class="tableau-indice">Le tableau défile horizontalement.</p>
    <table>
      <thead><tr><th scope="col"><span class="sr-only">Sélection</span></th><th scope="col">Paquet</th><th scope="col">Nature</th>
        <th scope="col">Installée</th><th scope="col">Proposée</th><th scope="col">Suite</th></tr></thead>
      <tbody>${lignes}</tbody>
    </table>
  </div>` : ''}
</section>`;
}

function renderSysteme(d) {
  const version = d?.version ?? {};
  const disponible = !version.connue ? '<span class="note">non relevée sur cette Forge</span>'
    : version.disponible
      ? `${badge('accent', `Ubuntu ${version.disponible} disponible`)} <span class="note">procédure
        de montée : <a href="#/manuel/M8">manuel M8</a></span>`
      : 'aucune';
  const redemarrage = d?.redemarrage?.requis
    ? `${badge('accent', 'redémarrage requis')}${d.redemarrage.paquets?.length
      ? ` <span class="note">demandé par</span> ${d.redemarrage.paquets
        .map((p) => `<span class="technique">${echapper(p)}</span>`).join(', ')}` : ''}`
    : 'non requis';
  return `<section class="carte bloc" aria-labelledby="titre-systeme">
  <h2 id="titre-systeme">Système</h2>
  <dl class="definitions">
    <div class="def"><dt>Version</dt><dd>${d?.os ? echapper(d.os) : '<span class="note">non relevée</span>'}</dd></div>
    <div class="def"><dt>Noyau</dt><dd class="technique">${d?.noyau ? echapper(d.noyau) : '<span class="note">non relevé</span>'}</dd></div>
    <div class="def"><dt>Redémarrage</dt><dd>${redemarrage}</dd></div>
    <div class="def"><dt>Nouvelle version d’Ubuntu</dt><dd>${disponible}</dd></div>
  </dl>
</section>`;
}

/** Les pools ZFS qui ont des fonctionnalités à activer (§70.6). */
function renderZfs(zfs) {
  const pools = zfs?.a_niveau ?? [];
  const corps = pools.length
    ? `<ul class="liste-simple">${pools.map((p) => `<li>
        <span class="technique">${echapper(p.pool)}</span> :
        ${pluriel(p.fonctionnalites.length, 'fonctionnalité à activer', 'fonctionnalités à activer')}
        — <span class="technique">${p.fonctionnalites.map(echapper).join(', ')}</span>
      </li>`).join('')}</ul>
      <p class="note">La mise à niveau est irréversible. Elle est proposée, décochée, dans
      l’installation de la Forge (<a href="#/forge">onglet Pools</a>).</p>`
    : '<p>Aucun pool n’a de fonctionnalité à activer.</p>';
  return `<section class="carte bloc" aria-labelledby="titre-zfs">
  <h2 id="titre-zfs">Pools ZFS</h2>
  ${corps}
</section>`;
}

export function renderMisesAJour(ui = SYSTEME_VIDE) {
  if (ui.status === 'loading') {
    return `${entete(false)}<section class="carte bloc" aria-busy="true">
  <h2>Mises à jour</h2><p class="note" role="status">Lecture de l’état du système…</p></section>`;
  }
  if (ui.status === 'erreur' || !ui.donnees) {
    return `${entete(false)}<section class="carte bloc" role="alert">
  <h2>L’état du système n’a pas pu être lu</h2>
  <p>${echapper(ui.error || 'La Forge n’a pas répondu.')}</p>
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-action="relire-systeme">Réessayer</button></p>
</section>`;
  }
  const d = ui.donnees;
  const demonstration = d.source === 'fake'
    ? ` ${badge('accent', 'relevé de démonstration')} <span>pilote factice : ces valeurs ne
      viennent d’aucune machine.</span>` : '';
  return `${entete(true)}
<p class="note" role="status">Relevé le <span class="technique">${
  echapper(date(d.releve_a))}</span>, en lecture seule.${demonstration}</p>
${renderSysteme(d)}
${renderPaquets(d.mises_a_jour, ui)}
${renderZfs(d.zfs)}`;
}
