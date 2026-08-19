/**
 * Point d'entrée de la console dans le navigateur.
 *
 * @spec docs/BACKLOG.md#SPK-18, docs/BACKLOG.md#SPK-21 ·
 *       docs/DAT.md §26 (les trois panneaux d'administration, §26.2 le contrat
 *       d'interaction, §26.5 l'ordre refus-puis-acceptation) ·
 *       docs/BACKLOG.md#SPK-22 · docs/DAT.md §27 (l'écran des pools) ·
 *       docs/DESIGN_SYSTEM.md §5.1, §6.13, §6.22, §9.1, §9.7
 */

import { renderSparksView } from './components/sparks-view.js';
import { renderSparkDetail } from './components/spark-detail.js';
import { renderSparkCreate, validateShape, DEFAUTS } from './components/spark-create.js';
import { ADMIN_VIDE } from './components/spark-admin.js';
import { renderHostView } from './components/host-view.js';

const racine = document.getElementById('racine');
const etat = { status: 'loading', sparks: [], usage: {}, error: null,
               sort: { key: 'name', dir: 'asc' }, tunnel: null, server: null,
               route: 'liste', spark: null, detail: {}, confirming: null,
               creation: { values: { ...DEFAUTS }, errors: {}, refusal: null,
                           pools: null, submitting: false },
               admin: { ...ADMIN_VIDE, values: { ...ADMIN_VIDE.values } },
               hote: { status: 'loading', host: null, cores: null,
                       sparkNames: {}, error: null, syncing: false } };

/**
 * L'indicateur de page courante SUIT la route.
 *
 * Il était écrit en dur sur « Sparks » : sur l'écran de l'hôte, un lecteur
 * d'écran annonçait donc la mauvaise page courante (docs/DESIGN_SYSTEM.md §5.1,
 * §9.7). Un indicateur qui ment est pire qu'un indicateur absent.
 */
function marquerNavigation() {
  const courant = etat.route === 'hote' ? '#/hote' : '#/sparks';
  for (const lien of racine.querySelectorAll('nav a')) {
    if (lien.getAttribute('href') === courant) lien.setAttribute('aria-current', 'page');
    else lien.removeAttribute('aria-current');
  }
}

function peindre() {
  marquerNavigation();
  racine.querySelector('.principal').innerHTML =
    etat.route === 'hote'
      ? renderHostView(etat.hote)
      : etat.route === 'creation'
      ? renderSparkCreate(etat.creation)
      : etat.route === 'detail'
      ? renderSparkDetail({ status: etat.status, spark: etat.spark, error: etat.error,
                            confirming: etat.confirming, admin: etat.admin, ...etat.detail })
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
  // §27.8 : le relevé ne détruit rien et n'a aucun paramètre — pas de confirmation.
  racine.querySelector('[data-action="relever"]')?.addEventListener('click', relever);

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
  brancherPanneaux();
  racine.querySelector('[data-confirme]')?.addEventListener('click', () => lancer('delete'));
  racine.querySelector('[data-annule]')?.addEventListener('click', () => {
    etat.confirming = null;
    peindre();
    // §6.22 : l'annulation rend le focus au déclencheur.
    racine.querySelector('[data-commande="delete"]')?.focus();
  });
}

/**
 * Gestes des trois panneaux (docs/DAT.md §26).
 *
 * Le contrat d'interaction du §26.2 vaut pour les trois : le focus entre dans le
 * formulaire à l'ouverture, l'annulation le rend au déclencheur, et un refus du
 * serveur ne touche pas à la saisie.
 */
function brancherPanneaux() {
  const admin = etat.admin;

  for (const bouton of racine.querySelectorAll('[data-ouvre]')) {
    bouton.addEventListener('click', () => {
      admin.open = bouton.dataset.ouvre;
      admin.refusal = null;
      admin.confirming = null;
      peindre();
      racine.querySelector('.formulaire-panneau .controle')?.focus();
    });
  }
  for (const bouton of racine.querySelectorAll('[data-ferme]')) {
    bouton.addEventListener('click', () => {
      const panneau = bouton.dataset.ferme;
      admin.open = null;
      admin.refusal = null;
      peindre();
      // §26.2 : l'annulation rend le focus au bouton déclencheur.
      racine.querySelector(`[data-ouvre="${panneau}"]`)?.focus();
    });
  }
  for (const bouton of racine.querySelectorAll('[data-annule]')) {
    bouton.addEventListener('click', () => {
      admin.confirming = null;
      admin.refusal = null;
      peindre();
    });
  }

  const formulaire = racine.querySelector('.formulaire-panneau');
  if (formulaire) {
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        admin.values[controle.name] =
          controle.type === 'checkbox' ? controle.checked
          : controle.type === 'number' ? Number(controle.value)
          : controle.value;
      });
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      const quoi = formulaire.dataset.formulaire;
      if (quoi === 'route') return declarerRoute();
      if (quoi === 'key') return autoriserCle();
      if (quoi === 'snapshot') return prendreInstantane();
    });
  }

  // Demandes de confirmation : elles n'appellent rien, elles ouvrent le bloc.
  const demande = (attribut, kind) => {
    for (const bouton of racine.querySelectorAll(`[data-${attribut}]`)) {
      bouton.addEventListener('click', () => {
        admin.confirming = { kind, id: bouton.getAttribute(`data-${attribut}`) };
        admin.refusal = null;
        peindre();
        // §6.22 : le focus entre dans la confirmation.
        racine.querySelector('.confirmation .bouton--destructif')?.focus();
      });
    }
  };
  demande('retire-route', 'route');
  demande('restaure', 'snapshot-restore');
  demande('supprime-instantane', 'snapshot-delete');

  const geste = (attribut, action) => {
    for (const bouton of racine.querySelectorAll(`[data-${attribut}]`)) {
      bouton.addEventListener('click', () => action(bouton.getAttribute(`data-${attribut}`)));
    }
  };
  geste('confirme-route', (domaine) =>
    agir('route', () => appel('DELETE', `/v1/ingress/${encodeURIComponent(domaine)}`)));
  geste('reapplique', () =>
    agir('route', () => appel('POST', '/v1/ingress/reconcile')));
  geste('revoque', (label) =>
    agir('key', () => appel('DELETE',
      `/v1/sparks/${encodeURIComponent(etat.spark.name)}/ssh-keys/${encodeURIComponent(label)}`)));
  geste('confirme-suppression', (nom) =>
    agir('snapshot', () => appel('DELETE',
      `/v1/sparks/${encodeURIComponent(etat.spark.name)}/snapshots/${encodeURIComponent(nom)}`)));
  geste('confirme-restauration', (nom) => restaurer(nom, false));
  // §26.5 : l'acceptation de la perte n'est atteignable qu'APRÈS le refus.
  geste('accepte-perte', (nom) => restaurer(nom, true));
}

/** Appel d'écriture. Rend toujours `{ ok, corps }` : un refus est une réponse,
 *  pas une exception à faire remonter jusqu'à l'écran d'erreur global. */
async function appel(methode, chemin, corps = null) {
  const reponse = await fetch(
    `/api${chemin}${chemin.includes('?') ? '&' : '?'}server=${encodeURIComponent(etat.server)}`,
    { method: methode, ...(corps ? { headers: { 'content-type': 'application/json' },
                                     body: JSON.stringify(corps) } : {}) });
  let rendu = null;
  try { rendu = await reponse.json(); } catch { /* corps vide */ }
  return { ok: reponse.ok, corps: rendu };
}

/**
 * Exécute un geste, puis RELIT l'état (§26.6). Aucun optimisme d'interface :
 * ces gestes touchent au réseau et au disque, et un état relu vaut mieux qu'un
 * état deviné.
 */
async function agir(panneau, operation, { ferme = true } = {}) {
  etat.admin.busy = true;
  peindre();
  let resultat;
  try {
    resultat = await operation();
  } catch (erreur) {
    resultat = { ok: false, corps: { detail: { message: erreur.message } } };
  }
  etat.admin.busy = false;
  if (!resultat.ok) {
    const detail = resultat.corps?.detail ?? resultat.corps ?? {};
    etat.admin.refusal = { panel: panneau, message: detail.message ?? 'Le serveur a refusé ce geste.' };
    etat.admin.confirming = null;
    peindre();
    return resultat;
  }
  etat.admin.confirming = null;
  etat.admin.refusal = null;
  if (ferme) etat.admin.open = null;
  await chargerDetail(etat.spark.name);
  return resultat;
}

async function declarerRoute() {
  const v = etat.admin.values;
  // §26.3 : aucun contrôle d'unicité ici. Le domaine est UNIQUE en base.
  const resultat = await agir('route', () => appel('POST', '/v1/ingress', {
    spark: etat.spark.name, domain: v.domain, port: Number(v.port), tls: Boolean(v.tls),
  }));
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
}

async function autoriserCle() {
  const v = etat.admin.values;
  const nom = etat.spark.name;
  const resultat = await agir('key', async () => {
    // Enregistrer puis accorder restent DEUX effets (§26.4) : la console les
    // enchaîne, elle ne les confond pas.
    if (v.new_label && v.public_key) {
      const inscrit = await appel('POST', '/v1/ssh-keys',
                                  { label: v.new_label, public_key: v.public_key });
      if (!inscrit.ok) return inscrit;
      return appel('POST', `/v1/sparks/${encodeURIComponent(nom)}/ssh-keys/${encodeURIComponent(v.new_label)}`);
    }
    if (!v.key_label) {
      return { ok: false, corps: { detail: {
        message: 'Choisissez une clé du registre, ou saisissez un libellé et une clé publique.' } } };
    }
    return appel('POST', `/v1/sparks/${encodeURIComponent(nom)}/ssh-keys/${encodeURIComponent(v.key_label)}`);
  });
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
}

async function prendreInstantane() {
  const resultat = await agir('snapshot', () => appel(
    'POST', `/v1/sparks/${encodeURIComponent(etat.spark.name)}/snapshots`,
    { name: etat.admin.values.snapshot }));
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
}

/**
 * Restaure. Un refus « des instantanés plus récents bloquent » n'est pas une
 * erreur générique : il porte la liste de ce qui serait détruit, et c'est cette
 * liste qui rend la perte visible avant qu'on l'accepte (§26.5).
 */
async function restaurer(nom, accepteLaPerte) {
  const resultat = await agir('snapshot', () => appel(
    'POST', `/v1/sparks/${encodeURIComponent(etat.spark.name)}/snapshots/${encodeURIComponent(nom)}/restore`,
    accepteLaPerte ? { accept_losing_newer: true } : {}));
  const detail = resultat?.corps?.detail;
  if (!resultat?.ok && detail?.error === 'blocked_by_newer_snapshots') {
    etat.admin.refusal = { panel: 'snapshot', snapshot: nom,
                           message: detail.message, blocking: detail.blocking ?? [] };
    peindre();
    racine.querySelector('[data-accepte-perte]')?.focus();
  }
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
    // Le runtime nomme ses refus ; l'appelant en a besoin pour distinguer un
    // état nommé d'une panne (docs/DAT.md §27.8).
    erreur.code = corps?.detail?.error ?? null;
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
    const [usage, routes, sshConfig, registry, snapshots, audit] = await Promise.all([
      api(`/v1/sparks/${encodeURIComponent(nom)}/usage`).catch(() => null),
      api('/v1/ingress').then((r) => r.routes.filter((x) => x.spark_name === nom)).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/ssh-config`).catch(() => null),
      api('/v1/ssh-keys').then((r) => r.keys).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/snapshots`).then((s) => s.snapshots).catch(() => []),
      api('/v1/audit?limit=200').then((a) => a.entries.filter((e) => e.target_id === etat.spark.id)).catch(() => []),
    ]);
    etat.detail = { usage, routes, keys: sshConfig?.keys ?? [], registry, sshConfig,
                    snapshots, audit };
    etat.status = 'ready';
  } catch (erreur) {
    etat.status = 'error';
    etat.error = erreur;
  }
  peindre();
}

/**
 * Écran des pools (docs/DAT.md §27).
 *
 * Une topologie jamais relevée répond `409 host_not_synced` : ce n'est pas une
 * panne mais une machine qu'on n'a pas encore interrogée, et l'écran présente
 * son remède comme une action (§27.8).
 */
async function chargerHote() {
  etat.route = 'hote';
  etat.hote.status = 'loading';
  etat.hote.error = null;
  peindre();
  try {
    etat.hote.host = await api('/v1/host');
    const [cores, sparks] = await Promise.all([
      api('/v1/host/cores').catch(() => null),
      api('/v1/sparks').then((r) => r.sparks).catch(() => []),
    ]);
    etat.hote.cores = cores;
    // La carte des cœurs porte des identifiants de Sparks ; l'écran affiche des
    // NOMS. Un identifiant interne sans intérêt ne doit pas atteindre l'écran
    // (docs/DESIGN_SYSTEM.md §3.1).
    etat.hote.sparkNames = Object.fromEntries(sparks.map((s) => [s.id, s.name]));
    etat.hote.status = 'ready';
  } catch (erreur) {
    etat.hote.error = erreur;
    etat.hote.status = erreur.code === 'host_not_synced' ? 'not-synced' : 'error';
  }
  peindre();
}

async function relever() {
  etat.hote.syncing = true;
  peindre();
  try {
    await fetch(`/api/v1/host/sync?server=${encodeURIComponent(etat.server)}`, { method: 'POST' });
  } catch { /* l'état réel sera relu ci-dessous */ }
  etat.hote.syncing = false;
  await chargerHote();
}

function router() {
  if (location.hash === '#/hote') return chargerHote();
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
