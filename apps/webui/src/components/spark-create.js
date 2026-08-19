/**
 * Écran « créer un Spark ».
 *
 * @spec docs/BACKLOG.md#SPK-20 · docs/DAT.md §25 (montrer sans décider),
 *       §25.2 (un refus n'efface pas la saisie), §25.3 (ce qui reste local) ·
 *       docs/DESIGN_SYSTEM.md §6.9, §6.12, §7.1, §14.9
 *
 * Cet écran montre la capacité restante ; il ne décide jamais à la place de
 * `sparkd`. Le bouton n'est pas désactivé parce que l'estimation locale juge la
 * demande trop grande : cette estimation est une photographie qui peut être
 * périmée, et dans le sens favorable.
 */

import { formatBytes, formatBps, formatCpu } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const GIO = 1024 ** 3;

export const DEFAUTS = {
  name: '', image: 'images:debian/13', cpu_mode: 'shared',
  cpu_reservation: 0.5, cpu_max: 0.5, cpu_cores: 1,
  memory_gib: 2, storage_gib: 10, network_mbit: 100,
};

/** Noms de ressources rendus en français. Une valeur technique brute ne doit
 *  pas atteindre l'écran (docs/DESIGN_SYSTEM.md §14.7). */
export const RESSOURCES = {
  cpu: { nom: 'processeur', format: (v) => `${formatCpu(v)} CPU` },
  memory: { nom: 'mémoire', format: formatBytes },
  storage: { nom: 'disque', format: formatBytes },
  network: { nom: 'réseau', format: formatBps },
};

export function describeShortfall(manque) {
  const info = RESSOURCES[manque.resource];
  const nom = info?.nom ?? manque.resource;
  const quantite = info ? info.format(manque.missing) : String(manque.missing);
  return `${nom} : il manque ${quantite}`;
}

export const MODES = {
  shared: 'Partagé — part du pool, burst autorisé',
  capped: 'Plafonné — jamais au-delà du plafond',
  dedicated: 'Dédié — cœurs physiques exclusifs',
  'shared-pinned': 'Épinglé partagé — cœurs imposés, non exclusifs',
};

/**
 * Contrôles LOCAUX. Ils portent sur la forme, jamais sur la capacité
 * (docs/DAT.md §25.3), et le runtime les double.
 */
export function validateShape(valeurs) {
  const erreurs = {};
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(valeurs.name ?? '')) {
    erreurs.name = valeurs.name
      ? 'Minuscules, chiffres et tirets, sans tiret aux extrémités.'
      : 'Requis pour créer un Spark.';
  }
  if (valeurs.cpu_mode === 'capped' && !(valeurs.cpu_max > 0))
    erreurs.cpu_max = 'Le mode plafonné demande un plafond.';
  if (['dedicated', 'shared-pinned'].includes(valeurs.cpu_mode) && !(valeurs.cpu_cores >= 1))
    erreurs.cpu_cores = 'Ce mode demande au moins un cœur.';
  if (['shared', 'shared-pinned'].includes(valeurs.cpu_mode) && !(valeurs.cpu_reservation > 0))
    erreurs.cpu_reservation = 'Ce mode demande une réservation.';
  for (const [champ, libelle] of [['memory_gib', 'La mémoire'], ['storage_gib', 'Le disque'],
                                  ['network_mbit', 'Le débit']]) {
    if (!(valeurs[champ] > 0)) erreurs[champ] = `${libelle} doit être supérieur à zéro.`;
  }
  return erreurs;
}

/** Ce que la demande prendrait au pool, selon les mêmes règles que le runtime. */
export function demandOf(valeurs) {
  const cpu = valeurs.cpu_mode === 'capped' ? valeurs.cpu_max
    : valeurs.cpu_mode === 'dedicated' ? 0
    : valeurs.cpu_reservation;
  return {
    cpu: Number(cpu) || 0,
    cores: valeurs.cpu_mode === 'dedicated' ? Number(valeurs.cpu_cores) || 0 : 0,
    memory: (Number(valeurs.memory_gib) || 0) * GIO,
    storage: (Number(valeurs.storage_gib) || 0) * GIO,
    network: (Number(valeurs.network_mbit) || 0) * 1e6,
  };
}

/**
 * Estimation locale. Rend les ressources qui **risquent** de manquer.
 *
 * Le mot « risquent » est important : cette photographie peut être périmée, et
 * l'écran n'en tire jamais un refus (docs/DAT.md §25.1).
 */
export function estimate(valeurs, pools) {
  if (!pools) return [];
  const demande = demandOf(valeurs);
  const paires = [
    ['cpu', demande.cpu, pools.cpu?.available, (v) => `${formatCpu(v)} CPU`],
    ['mémoire', demande.memory, pools.memory?.available, formatBytes],
    ['disque', demande.storage, pools.storage?.available, formatBytes],
    ['réseau', demande.network, pools.network?.available, formatBps],
  ];
  return paires
    .filter(([, veut, reste]) => reste !== undefined && reste !== null && veut > reste)
    .map(([nom, veut, reste, f]) => ({ resource: nom, requested: f(veut), available: f(reste) }));
}

function champ({ id, libelle, aide, erreur, controle }) {
  return `<div class="champ">
  <label for="${id}">${echapper(libelle)}</label>
  ${controle}
  ${aide ? `<p class="champ__aide" id="${id}-aide">${echapper(aide)}</p>` : ''}
  ${erreur ? `<p class="champ__erreur" id="${id}-erreur" role="alert">${echapper(erreur)}</p>` : ''}
</div>`;
}

function nombre(id, valeur, pas, erreur, aide) {
  const decrits = [aide ? `${id}-aide` : '', erreur ? `${id}-erreur` : ''].filter(Boolean).join(' ');
  return `<input type="number" id="${id}" name="${id}" value="${echapper(valeur)}" step="${pas}" min="0"
    class="controle${erreur ? ' controle--erreur' : ''}"${decrits ? ` aria-describedby="${decrits}"` : ''}${erreur ? ' aria-invalid="true"' : ''} />`;
}

/** Capacité restante, affichée pour dimensionner — pas pour interdire. */
function renderPools(pools) {
  if (!pools) return '<p class="absence">Capacité de l’hôte inconnue.</p>';
  const lignes = [
    ['CPU', pools.cpu, (v) => `${formatCpu(v)} CPU`],
    ['Mémoire', pools.memory, formatBytes],
    ['Disque', pools.storage, formatBytes],
    ['Réseau', pools.network, formatBps],
  ].map(([nom, pool, f]) =>
    `<div class="def"><dt>${nom}</dt><dd class="technique">${echapper(f(pool.available))} libres sur ${echapper(f(pool.capacity))}</dd></div>`,
  ).join('');
  return `<dl class="definitions">${lignes}</dl>`;
}

export function renderSparkCreate({ values = DEFAUTS, pools = null, errors = {},
                                    refusal = null, submitting = false } = {}) {
  const v = { ...DEFAUTS, ...values };
  const risques = estimate(v, pools);

  // Une fois que le serveur a tranché, l'estimation locale n'est plus qu'un
  // doublon bruyant : c'est le refus qui fait autorité (docs/DAT.md §25.1).
  const avertissement = risques.length && !refusal
    ? `<p class="avertissement" role="status">D’après la capacité relevée à l’ouverture,
       ${echapper(risques.map((r) => `${r.resource} (${r.requested} demandés, ${r.available} libres)`).join(', '))}
       pourrai${risques.length > 1 ? 'ent' : 't'} manquer. La création reste possible :
       c’est le serveur qui décide.</p>`
    : '';

  // §7.1 et §25.2 : le refus est près de l'action, et la saisie est intacte.
  const refus = refusal
    ? `<div class="refus" role="alert">
         <p><strong>Le serveur a refusé cette création.</strong></p>
         ${(refusal.shortfalls ?? []).length
           ? `<ul class="liste-simple">${refusal.shortfalls.map((s) =>
               `<li>${echapper(describeShortfall(s))}</li>`).join('')}</ul>`
           : ''}
       </div>`
    : '';

  const modeOptions = Object.entries(MODES).map(([cle, libelle]) =>
    `<option value="${cle}"${v.cpu_mode === cle ? ' selected' : ''}>${echapper(libelle)}</option>`).join('');

  const champsCpu = [
    ['shared', 'shared-pinned'].includes(v.cpu_mode)
      ? champ({ id: 'cpu_reservation', libelle: 'Réservation CPU', erreur: errors.cpu_reservation,
                aide: 'Droit d’ordonnancement sous contention, pas un plafond.',
                controle: nombre('cpu_reservation', v.cpu_reservation, '0.05', errors.cpu_reservation, true) })
      : '',
    v.cpu_mode === 'capped'
      ? champ({ id: 'cpu_max', libelle: 'Plafond CPU', erreur: errors.cpu_max,
                aide: 'Jamais dépassé. Pas de burst.',
                controle: nombre('cpu_max', v.cpu_max, '0.05', errors.cpu_max, true) })
      : '',
    ['dedicated', 'shared-pinned'].includes(v.cpu_mode)
      ? champ({ id: 'cpu_cores', libelle: 'Cœurs', erreur: errors.cpu_cores,
                aide: 'Cœurs physiques entiers, frères SMT compris.',
                controle: nombre('cpu_cores', v.cpu_cores, '1', errors.cpu_cores, true) })
      : '',
  ].join('');

  return `
<p><a class="lien-spark" href="#/sparks">← Tous les Sparks</a></p>
<div class="titre-vue"><h1>Créer un Spark</h1></div>
<div class="detail">
  <div class="detail__principal">
    <form class="carte bloc" id="formulaire-spark" novalidate>
      ${champ({ id: 'name', libelle: 'Nom', erreur: errors.name,
                aide: 'Minuscules, chiffres et tirets.',
                controle: `<input type="text" id="name" name="name" value="${echapper(v.name)}"
                  class="controle${errors.name ? ' controle--erreur' : ''}" aria-describedby="name-aide${errors.name ? ' name-erreur' : ''}"${errors.name ? ' aria-invalid="true"' : ''} />` })}
      ${champ({ id: 'image', libelle: 'Image', controle:
        `<input type="text" id="image" name="image" value="${echapper(v.image)}" class="controle" />` })}
      ${champ({ id: 'cpu_mode', libelle: 'Mode CPU', controle:
        `<select id="cpu_mode" name="cpu_mode" class="controle">${modeOptions}</select>` })}
      ${champsCpu}
      ${champ({ id: 'memory_gib', libelle: 'Mémoire (Gio)', erreur: errors.memory_gib,
                controle: nombre('memory_gib', v.memory_gib, '1', errors.memory_gib) })}
      ${champ({ id: 'storage_gib', libelle: 'Disque (Gio)', erreur: errors.storage_gib,
                controle: nombre('storage_gib', v.storage_gib, '1', errors.storage_gib) })}
      ${champ({ id: 'network_mbit', libelle: 'Débit (Mbit/s)', erreur: errors.network_mbit,
                aide: 'Sert à la comptabilité ; seul le plafond est appliqué par le noyau.',
                controle: nombre('network_mbit', v.network_mbit, '10', errors.network_mbit, true) })}
      ${avertissement}
      ${refus}
      <p class="formulaire__actions">
        <button type="submit" class="bouton bouton--primaire"${submitting ? ' disabled' : ''}>
          ${submitting ? 'Création…' : 'Créer le Spark'}</button>
        <a class="bouton" href="#/sparks">Annuler</a>
      </p>
    </form>
  </div>
  <div class="detail__secondaire">
    <section class="carte bloc" aria-labelledby="titre-capacite">
      <h2 id="titre-capacite">Capacité restante</h2>
      ${renderPools(pools)}
      <p class="note">Relevée à l’ouverture de cet écran. Elle peut avoir changé
      depuis : c’est le serveur qui tranche à la création.</p>
    </section>
  </div>
</div>`;
}
