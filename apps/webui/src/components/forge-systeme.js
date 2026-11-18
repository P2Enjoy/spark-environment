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
 * Lecture seule : appliquer une mise à jour depuis la console n'est pas décidé
 * (§70.5). L'écran donne la commande à lancer sur la Forge, et le manuel M8
 * explique quand et comment.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SYSTEME_VIDE = Object.freeze({ status: 'loading', donnees: null, error: null });

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
function renderPaquets(maj) {
  const total = Number(maj?.total ?? 0);
  const securite = maj?.securite;
  const relue = maj?.liste_relue_a
    ? `Liste des paquets relue le <span class="technique">${echapper(date(maj.liste_relue_a))}</span>.`
    : 'Date de la liste des paquets inconnue.';
  if (total === 0) {
    return `<section class="carte bloc" aria-labelledby="titre-paquets">
  <h2 id="titre-paquets">Paquets</h2>
  <p>${badge('success', 'à jour')} Aucune mise à jour en attente.</p>
  <p class="note">${relue}</p>
</section>`;
  }
  const resume = securite === null || securite === undefined
    ? `${pluriel(total, 'mise à jour en attente', 'mises à jour en attente')} — part de sécurité non relevée`
    : `${pluriel(total, 'mise à jour en attente', 'mises à jour en attente')}, dont ${
      pluriel(securite, 'de sécurité', 'de sécurité')}`;
  const paquets = maj?.paquets ?? [];
  const partiel = paquets.length < total
    ? `<p class="note">${paquets.length ? `Les ${paquets.length} premiers paquets sur ${total}.`
      : 'La liste détaillée n’a pas pu être lue ; seul le nombre est connu.'}</p>` : '';
  const lignes = paquets.map((p) => `<tr>
      <td class="technique">${echapper(p.nom)}</td>
      <td>${p.securite ? badge('danger', 'sécurité') : '<span class="note">courante</span>'}</td>
      <td class="technique cellule-dense" title="${echapper(p.installee)}">${echapper(p.installee)}</td>
      <td class="technique cellule-dense" title="${echapper(p.proposee)}">${echapper(p.proposee)}</td>
      <td class="technique">${echapper(p.suite)}</td>
    </tr>`).join('');
  return `<section class="carte bloc" aria-labelledby="titre-paquets">
  <h2 id="titre-paquets">Paquets</h2>
  <p>${badge(securite ? 'danger' : 'accent', resume)}</p>
  <p class="note">${relue} Pour les appliquer, sur la Forge :
    <span class="technique">sudo apt upgrade</span>
    (<a href="#/manuel/M8">manuel M8 — Mettre à jour le système</a>).</p>
  ${partiel}
  ${paquets.length ? `<div class="tableau-enveloppe">
    <p class="tableau-indice">Le tableau défile horizontalement.</p>
    <table>
      <thead><tr><th scope="col">Paquet</th><th scope="col">Nature</th>
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
${renderPaquets(d.mises_a_jour)}
${renderZfs(d.zfs)}`;
}
