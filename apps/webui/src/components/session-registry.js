/**
 * Registre local des sessions de terminal encore vivantes.
 *
 * @spec docs/BACKLOG.md#SPK-70 · docs/DAT.md §37.4.4, §37.5 ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-04
 *
 * Le registre ne reçoit que `Session.describe()` : il ne sait donc ni rendre,
 * ni mémoriser une frappe ou une sortie. Ajouter une colonne de contenu ici
 * serait une violation directe du §37.5.
 */

const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TYPES = {
  spark: 'Spark', container: 'Conteneur', rescue: 'Dépannage',
};
const CHEMINS = {
  ssh: 'SSH', container: 'Conteneur', rescue: 'Dépannage',
};

function dateLocale(valeur) {
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return 'heure indisponible';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function renderSessionRegistry({ sessions = [], confirmation = null } = {}) {
  if (sessions.length === 0) {
    return '<p class="absence">Aucune session ouverte.</p>';
  }
  return `<ul class="registre-sessions__liste">${sessions.map((session) => {
    const estConfirmee = confirmation === session.id;
    const nom = session.type === 'container' && session.container
      ? `${session.spark} / ${session.container}` : session.spark;
    return `<li class="registre-sessions__ligne">
      <button type="button" class="registre-sessions__selection"
              data-session-select="${echapper(session.id)}">
        <strong>${echapper(TYPES[session.type] ?? 'Session')} · ${echapper(nom)}</strong>
        <span class="registre-sessions__meta">Forge : ${echapper(session.forge ?? 'inconnue')}</span>
        <span class="registre-sessions__meta">Chemin : ${echapper(CHEMINS[session.path] ?? 'inconnu')}</span>
        <span class="registre-sessions__meta">Ouverte : ${echapper(dateLocale(session.openedAt))}</span>
        <span class="registre-sessions__meta">Dernière activité : ${echapper(dateLocale(session.lastActivity))}</span>
      </button>
      ${estConfirmee
        ? `<div class="registre-sessions__confirmation" role="group" aria-label="Confirmation de fermeture">
             <p>Fermer le terminal ${echapper(TYPES[session.type] ?? 'de cette')} « ${echapper(nom)} » ? Le shell distant sera tué.</p>
             <p class="registre-sessions__actions">
               <button type="button" class="bouton bouton--destructif" data-session-close-confirm="${echapper(session.id)}">Fermer et tuer le shell</button>
               <button type="button" class="bouton" data-session-close-cancel>Annuler</button>
             </p>
           </div>`
        : `<p class="registre-sessions__actions"><button type="button" class="bouton bouton--compact" data-session-close="${echapper(session.id)}">Fermer</button></p>`}
    </li>`;
  }).join('')}</ul>`;
}
