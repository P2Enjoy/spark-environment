/**
 * Point d'entrée de la console dans le navigateur.
 *
 * @spec docs/BACKLOG.md#SPK-18 · docs/DESIGN_SYSTEM.md §5.1, §6.13, §9.1, §9.7
 */

import { renderSparksView } from './components/sparks-view.js';
import { renderSparkDetail } from './components/spark-detail.js';
import { renderSparkCreate, validateShape, DEFAUTS } from './components/spark-create.js';

const racine = document.getElementById('racine');
const etat = { status: 'loading', sparks: [], usage: {}, error: null,
               sort: { key: 'name', dir: 'asc' }, tunnel: null, server: null,
               route: 'liste', spark: null, detail: {}, confirming: null,
               creation: { values: { ...DEFAUTS }, errors: {}, refusal: null,
                           pools: null, submitting: false } };

function peindre() {
  racine.querySelector('.principal').innerHTML =
    etat.route === 'creation'
      ? renderSparkCreate(etat.creation)
      : etat.route === 'detail'
      ? renderSparkDetail({ status: etat.status, spark: etat.spark, error: etat.error,
                            confirming: etat.confirming, ...etat.detail })
      : renderSparksView(etat);
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
  racine.querySelector('[data-action="reessayer"]')?.addEventListener('click', router);

  const formulaire = racine.querySelector('#formulaire-spark');
  if (formulaire) {
    // Les valeurs vivent dans l'état : un refus ne doit rien effacer (§25.2).
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        const brut = controle.value;
        etat.creation.values[controle.name] =
          controle.type === 'number' ? Number(brut) : brut;
        if (controle.name === 'cpu_mode') peindre();   // les champs suivent le mode
      });
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      creer();
    });
  }

  racine.querySelector('.etat-vue .bouton--primaire')?.addEventListener('click', () => {
    location.hash = '#/creer';
  });

  for (const bouton of racine.querySelectorAll('[data-commande]')) {
    bouton.addEventListener('click', () => {
      const commande = bouton.dataset.commande;
      // Seule la suppression passe par une confirmation (docs/DAT.md §24.2).
      if (commande === 'delete') {
        etat.confirming = 'delete';
        peindre();
        // §6.22 : le focus entre dans la confirmation.
        racine.querySelector('[data-confirme]')?.focus();
        return;
      }
      lancer(commande);
    });
  }
  racine.querySelector('[data-confirme]')?.addEventListener('click', () => lancer('delete'));
  racine.querySelector('[data-annule]')?.addEventListener('click', () => {
    etat.confirming = null;
    peindre();
    // §6.22 : l'annulation rend le focus au déclencheur.
    racine.querySelector('[data-commande="delete"]')?.focus();
  });
}

async function lancer(commande) {
  etat.confirming = null;
  etat.status = 'loading';
  peindre();
  try {
    await fetch(`/api/v1/sparks/${encodeURIComponent(etat.spark.name)}/${commande}?server=${encodeURIComponent(etat.server)}`,
                { method: 'POST' });
  } catch { /* l'état réel sera relu ci-dessous */ }
  if (commande === 'delete') { location.hash = '#/sparks'; return router(); }
  await router();
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

async function chargerCreation() {
  etat.route = 'creation';
  etat.status = 'ready';
  peindre();
  try {
    const hote = await api('/v1/host');
    etat.creation.pools = hote.pools;
  } catch {
    // Capacité inconnue : l'écran le dit plutôt que d'inventer des chiffres.
    etat.creation.pools = null;
  }
  peindre();
}

async function creer() {
  // Contrôles de FORME seulement. La capacité, c'est sparkd qui tranche (§25.3).
  etat.creation.errors = validateShape(etat.creation.values);
  etat.creation.refusal = null;
  if (Object.keys(etat.creation.errors).length > 0) {
    peindre();
    // §6.12 : amener le premier champ concerné et y déplacer le focus.
    const premier = Object.keys(etat.creation.errors)[0];
    racine.querySelector(`#${premier}`)?.focus();
    return;
  }

  etat.creation.submitting = true;
  peindre();
  const v = etat.creation.values;
  const corps = {
    name: v.name, image: v.image, cpu_mode: v.cpu_mode,
    memory_bytes: Math.round(v.memory_gib * 1024 ** 3),
    network_bps: Math.round(v.network_mbit * 1e6),
    storage_bytes: Math.round(v.storage_gib * 1024 ** 3),
    ...(['shared', 'shared-pinned'].includes(v.cpu_mode) ? { cpu_reservation: v.cpu_reservation } : {}),
    ...(v.cpu_mode === 'capped' ? { cpu_max: v.cpu_max } : {}),
    ...(['dedicated', 'shared-pinned'].includes(v.cpu_mode) ? { cpu_cores: v.cpu_cores } : {}),
  };
  try {
    const reponse = await fetch(`/api/v1/sparks?server=${encodeURIComponent(etat.server)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps) });
    const rendu = await reponse.json();
    if (!reponse.ok) {
      // Le refus vient du serveur, et la saisie reste intacte (§25.2).
      etat.creation.refusal = rendu?.detail ?? { message: rendu?.message ?? `HTTP ${reponse.status}` };
      etat.creation.submitting = false;
      peindre();
      racine.querySelector('.refus')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    etat.creation.values = { ...DEFAUTS };
    etat.creation.submitting = false;
    location.hash = `#/sparks/${encodeURIComponent(rendu.name)}`;
  } catch (erreur) {
    etat.creation.refusal = { message: erreur.message };
    etat.creation.submitting = false;
    peindre();
  }
}

async function chargerDetail(nom) {
  etat.route = 'detail';
  etat.status = 'loading';
  etat.error = null;
  peindre();
  try {
    etat.spark = await api(`/v1/sparks/${encodeURIComponent(nom)}`);
    const [usage, routes, keys, snapshots, audit] = await Promise.all([
      api(`/v1/sparks/${encodeURIComponent(nom)}/usage`).catch(() => null),
      api('/v1/ingress').then((r) => r.routes.filter((x) => x.spark_name === nom)).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/ssh-config`).then((c) => c.keys).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/snapshots`).then((s) => s.snapshots).catch(() => []),
      api('/v1/audit?limit=200').then((a) => a.entries.filter((e) => e.target_id === etat.spark.id)).catch(() => []),
    ]);
    etat.detail = { usage, routes, keys, snapshots, audit };
    etat.status = 'ready';
  } catch (erreur) {
    etat.status = 'error';
    etat.error = erreur;
  }
  peindre();
}

function router() {
  if (location.hash === '#/creer') return chargerCreation();
  const nom = (location.hash.match(/^#\/sparks\/(.+)$/) || [])[1];
  if (nom) return chargerDetail(decodeURIComponent(nom));
  etat.route = 'liste';
  etat.spark = null;
  return charger();
}

window.addEventListener('hashchange', router);

async function charger() {
  etat.route = 'liste';
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
  await router();
}

demarrer();
