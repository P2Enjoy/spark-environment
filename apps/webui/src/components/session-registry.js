/**
 * Widget flottant : l'inventaire de la Forge, et les shells vivants.
 *
 * @spec docs/BACKLOG.md#SPK-75, docs/BACKLOG.md#SPK-70 · docs/DAT.md §37.4.4,
 *       §37.4.8 (l'inventaire permanent et son coût), §37.5 (aucun octet de
 *       session) · docs/DESIGN_SYSTEM_APP.md SPK-DS-16, SPK-DS-04
 *
 * Il ne reçoit que `Session.describe()` et la liste des Sparks déjà en mémoire :
 * il ne sait donc ni rendre une grille, ni mémoriser une frappe ou une sortie.
 * Ajouter une colonne de contenu ici serait une violation directe du §37.5.
 *
 * **Il ne prend aucune largeur au contenu** (SPK-DS-16). Il remplace la colonne
 * de 355 px qui rétrécissait la grille du terminal qu'elle accompagnait.
 */

import { stateOf } from './tokens.js';

const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TYPES = { spark: 'Spark', container: 'Conteneur', rescue: 'Dépannage' };
const CHEMINS = { ssh: 'SSH', container: 'Conteneur', rescue: 'Dépannage' };

/** État initial du widget. `ouvert` survit au changement de page (SPK-DS-16). */
export const INVENTAIRE_VIDE = {
  items: [], confirmation: null, ouvert: false,
  deplies: {}, conteneurs: {},
};

function dateLocale(valeur) {
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return 'heure indisponible';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/** La session vivante d'une cible, s'il y en a une. */
function sessionDe(sessions, spark, conteneur = null) {
  return sessions.find((s) => s.spark === spark
    && (conteneur ? s.container === conteneur : !s.container)) ?? null;
}

/**
 * Une entrée : un Spark, ou un conteneur. Elle DIT si un shell y vit.
 *
 * §14.6 : « aucune session » et « session vivante » sont deux états, et le
 * libellé de l'action change avec eux — ouvrir n'est pas revenir.
 */
function entree({ libelle, sous, etat = null, session, action,
                  confirmation, indent = false, deplier = false, deplie = false }) {
  const vivante = Boolean(session);
  // §SPK-DS-01 : l'état d'un Spark se lit avec la table du reste de la console.
  // Rendre « stopped » ici pendant que le tableau dit « Arrêté » ferait douter
  // qu'il s'agit du même objet.
  const jeton = etat ? stateOf(etat) : null;
  return `<li class="widget-inv__ligne${indent ? ' widget-inv__ligne--fille' : ''}">
    <button type="button" class="widget-inv__cible" ${action}
            ${vivante ? 'data-vivante="oui"' : ''}>
      <span class="widget-inv__nom">${echapper(libelle)}</span>
      <span class="widget-inv__jetons">
        ${jeton
          ? `<span class="badge badge--${jeton.token}"><span class="badge__point"
             aria-hidden="true"></span>${echapper(jeton.label)}</span>`
          : ''}
        ${vivante
          ? '<span class="badge badge--success">shell ouvert</span>'
          : ''}
      </span>
      ${sous ? `<span class="widget-inv__meta">${echapper(sous)}</span>` : ''}
      ${vivante
        ? `<span class="widget-inv__meta">${echapper(CHEMINS[session.path] ?? 'inconnu')}
           · activité ${echapper(dateLocale(session.lastActivity))}</span>`
        : ''}
    </button>
    ${deplier
      ? `<button type="button" class="widget-inv__deplier"
           data-widget-deplier="${echapper(libelle)}"
           aria-expanded="${deplie ? 'true' : 'false'}">${
         deplie ? '▾ masquer les conteneurs' : '▸ conteneurs'}</button>`
      : ''}
    ${vivante && confirmation === session.id
      ? `<div class="widget-inv__confirmation" role="group" aria-label="Confirmation de fermeture">
           <p>Fermer le terminal ${echapper(TYPES[session.type] ?? 'de cette')}
              « ${echapper(libelle)} » ? Le shell distant sera tué.</p>
           <p class="widget-inv__actions">
             <button type="button" class="bouton bouton--destructif"
                     data-session-close-confirm="${echapper(session.id)}">Fermer et tuer le shell</button>
             <button type="button" class="bouton" data-session-close-cancel>Annuler</button>
           </p>
         </div>`
      : vivante
        ? `<p class="widget-inv__actions"><button type="button" class="bouton bouton--compact"
             data-session-close="${echapper(session.id)}">Fermer</button></p>`
        : ''}
  </li>`;
}

/**
 * Le widget. Replié, une pastille qui compte les shells ; déplié, l'inventaire.
 *
 * `sparks` vient de la mémoire de la console : les lister ne coûte aucune
 * requête. Les conteneurs, eux, ne sont relevés QUE pour un Spark déplié
 * (§37.4.8) — un Spark qu'on ne regarde pas n'est jamais interrogé.
 */
export function renderSessionRegistry({ sessions = [], confirmation = null,
                                        sparks = [], ouvert = false,
                                        deplies = {}, conteneurs = {},
                                        forge = null } = {}) {
  const vivantes = sessions.length;
  const pastille = `<button type="button" class="widget-inv__bascule"
      data-widget="basculer" aria-expanded="${ouvert ? 'true' : 'false'}"
      aria-controls="widget-inventaire-contenu">
      <span class="widget-inv__titre">Sparks &amp; conteneurs</span>
      ${vivantes
        ? `<span class="badge badge--success">${vivantes} shell${vivantes > 1 ? 's' : ''}</span>`
        : '<span class="badge badge--neutral">aucun shell</span>'}
    </button>`;

  if (!ouvert) {
    return `${pastille}<div id="widget-inventaire-contenu" hidden></div>`;
  }

  // Les sessions dont la cible n'est PLUS dans l'inventaire — un Spark supprimé,
  // une autre Forge — restent visibles : une session qu'on ne voit plus est une
  // session qu'on oublie, et c'est précisément ce que le widget existe pour
  // empêcher (§37.4.2 révisé).
  const connus = new Set(sparks.map((s) => s.name));
  const orphelines = sessions.filter((s) => !connus.has(s.spark));

  const lignes = sparks.map((spark) => {
    const session = sessionDe(sessions, spark.name);
    const deplie = Boolean(deplies[spark.name]);
    const releve = conteneurs[spark.name];
    const fille = !deplie ? '' : (() => {
      if (!releve || releve.status === 'chargement') {
        return '<li class="widget-inv__ligne widget-inv__ligne--fille"><p class="absence" role="status">Relevé des conteneurs…</p></li>';
      }
      if (releve.status === 'erreur') {
        return `<li class="widget-inv__ligne widget-inv__ligne--fille"><p class="absence" role="status">Conteneurs illisibles : ${echapper(releve.erreur)}</p></li>`;
      }
      const liste = releve.items ?? [];
      if (liste.length === 0) {
        return '<li class="widget-inv__ligne widget-inv__ligne--fille"><p class="absence">Aucun conteneur.</p></li>';
      }
      return liste.map((c) => entree({
        libelle: c.name, sous: c.image ?? null, indent: true,
        session: sessionDe(sessions, spark.name, c.name),
        confirmation,
        action: `data-widget-conteneur="${echapper(spark.name)}" data-conteneur="${echapper(c.name)}"`,
      })).join('');
    })();

    return `${entree({
      libelle: spark.name, etat: spark.state, session, confirmation,
      action: `data-widget-spark="${echapper(spark.name)}"`,
      deplier: true, deplie,
    })}${fille}`;
  }).join('');

  const corps = sparks.length === 0
    ? '<p class="absence">Aucun Spark sur cette Forge.</p>'
    : `<ul class="widget-inv__liste">${lignes}${orphelines.map((s) => entree({
        libelle: s.container ? `${s.spark} / ${s.container}` : s.spark,
        sous: `hors inventaire · Forge ${s.forge ?? 'inconnue'}`,
        session: s, confirmation,
        action: `data-session-select="${echapper(s.id)}"`,
      })).join('')}</ul>`;

  return `${pastille}
  <div id="widget-inventaire-contenu" class="widget-inv__contenu">
    ${forge ? `<p class="widget-inv__forge">Forge : <strong>${echapper(forge)}</strong></p>` : ''}
    ${corps}
  </div>`;
}
