/**
 * Point d'entrée de la console dans le navigateur.
 *
 * @spec docs/BACKLOG.md#SPK-18 · docs/DESIGN_SYSTEM.md §5.1, §6.13, §9.1, §9.7
 */

import { renderSparksView } from './components/sparks-view.js';

const racine = document.getElementById('racine');
const etat = { status: 'loading', sparks: [], usage: {}, error: null,
               sort: { key: 'name', dir: 'asc' }, tunnel: null, server: null };

function peindre() {
  racine.querySelector('.principal').innerHTML = renderSparksView(etat);
  brancher();
}

/** §9.1 : toute fonction est utilisable sans souris. Le tri est un bouton. */
function brancher() {
  for (const bouton of racine.querySelectorAll('[data-tri]')) {
    bouton.addEventListener('click', () => {
      const cle = bouton.dataset.tri;
      etat.sort = { key: cle, dir: etat.sort.key === cle && etat.sort.dir === 'asc' ? 'desc' : 'asc' };
      peindre();
      // §14.3 : le focus ne doit pas se perdre quand le contrôle est reconstruit.
      racine.querySelector(`[data-tri="${cle}"]`)?.focus();
    });
  }
  racine.querySelector('[data-action="reessayer"]')?.addEventListener('click', charger);
}

async function api(chemin) {
  const reponse = await fetch(`/api${chemin}${chemin.includes('?') ? '&' : '?'}server=${encodeURIComponent(etat.server)}`);
  const corps = await reponse.json();
  if (!reponse.ok) {
    const erreur = new Error(corps?.detail?.message ?? corps?.message ?? `HTTP ${reponse.status}`);
    erreur.tunnel = corps?.tunnel ?? null;
    throw erreur;
  }
  return corps;
}

async function charger() {
  etat.status = 'loading';
  etat.error = null;
  peindre();
  try {
    const { sparks } = await api('/v1/sparks');
    etat.sparks = sparks;
    etat.usage = {};
    // L'usage est demandé Spark par Spark : une mesure manquante n'empêche pas
    // d'afficher les autres.
    await Promise.all(sparks.map(async (s) => {
      try { etat.usage[s.name] = await api(`/v1/sparks/${encodeURIComponent(s.name)}/usage`); }
      catch { /* la vue nommera l'absence plutôt que d'inventer une valeur */ }
    }));
    etat.status = 'ready';
  } catch (erreur) {
    etat.status = 'error';
    etat.error = erreur;
    etat.tunnel = erreur.tunnel;
  }
  peindre();
}

async function demarrer() {
  const { servers, tunnels } = await (await fetch('/api/servers')).json();
  const entete = racine.querySelector('.entete__contexte');
  if (servers.length === 0) {
    entete.innerHTML = '<span class="badge badge--neutral">Aucun serveur enregistré</span>';
    etat.status = 'error';
    etat.error = new Error("Aucun serveur n'est enregistré dans l'inventaire de la console.");
    return peindre();
  }
  etat.server = servers[0].name;
  etat.tunnel = tunnels.find((t) => t.name === etat.server) ?? null;
  entete.innerHTML =
    `<span class="technique">${etat.server}</span>` +
    `<span class="badge badge--${etat.tunnel?.state === 'ready' ? 'success' : 'danger'}">` +
    `<span class="badge__point" aria-hidden="true"></span>Tunnel ${etat.tunnel?.state ?? 'fermé'}</span>`;
  await charger();
}

demarrer();
