/**
 * Écran « pools de ressources de la Forge ».
 *
 * @spec docs/BACKLOG.md#SPK-22, docs/BACKLOG.md#SPK-69 · docs/DAT.md §27 (rendre l'admission control
 *       observable), §27.2 (trois grandeurs), §27.3 (la soustraction mémoire),
 *       §8.8.2 (la marge de métadonnées est nommée à l'écran des pools),
 *       §27.4 (le CPU à deux endroits), §27.5 (le surengagement s'affiche),
 *       §27.6 (la réservation n'est pas une garantie), §27.8 (topologie) ·
 *       §7.7, §15, §16, §13.12 (l'ARC atteint son plafond sous charge) · docs/DESIGN_SYSTEM.md §3.1, §6.4, §6.13, §6.24, §14.6 ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * Cet écran répond à une seule question : « pourquoi cette création serait-elle
 * refusée, et de combien ? ». Tout ce qu'il affiche sert cette question.
 */

import { formatBytes, formatBps, formatCpu } from './tokens.js';
import { renderForgeInstaller } from './forge-installer.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Les quatre ressources, avec leur formateur et ce que le surengagement veut
 * dire pour chacune. Le stockage n'en porte AUCUN, et c'est délibéré (§7.7).
 */
export const RESSOURCES = [
  { cle: 'cpu', nom: 'Processeur partagé', format: (v) => `${formatCpu(v)} CPU`,
    surengageable: true },
  { cle: 'memory', nom: 'Mémoire', format: formatBytes, surengageable: true },
  { cle: 'storage', nom: 'Disque', format: formatBytes, surengageable: false,
    // §1.5 bis : l'écran NOMME le fait — pas de surengagement ici —, le manuel
    // explique pourquoi (manuel M4, « Le surengagement »). La phrase qui restait
    // vraie quand toutes les valeurs changent appartenait au manuel.
    sansFacteur: 'Aucun surengagement' },
  { cle: 'network', nom: 'Réseau', format: formatBps, surengageable: true },
];

/** Portées possibles de la réservation, telles que le runtime les publie.
 *  §27.6 : la valeur est LUE dans la réponse, jamais écrite en dur ici. */
export const GARANTIES = {
  // §1.5 bis : ce n'est pas une explication mais une QUALIFICATION de la valeur —
  // « 2,5 CPU alloués » se lirait comme une garantie sans elle. Elle reste donc à
  // l'écran, et reste LUE dans la réponse (§27.6), jamais écrite en dur.
  // §32.2, arbitrage du 2026-08-21 : la réservation est un PLANCHER. Le dire
  // « non garantie » était vrai et trop modeste ; le dire « garantie » serait
  // faux dès qu'une tranche de la Forge est au repos, car le Spark obtient alors
  // PLUS. Le mot juste est celui-ci.
  floor_under_contention:
    'Réservation garantie sous contention totale, dépassée sinon.',
  proportional_between_sparks_only:
    'Réservation proportionnelle entre Sparks — non garantie sous contention.',
  absolute:
    'Réservation garantie sous contention.',
};

/** Part occupée d'un pool, en pourcentage borné. */
export function fillRatio(pool) {
  if (!pool || !pool.capacity) return 0;
  return Math.max(0, Math.min(100, (pool.allocated / pool.capacity) * 100));
}

/**
 * Ce que l'ARC consomme réellement, face à son plafond.
 *
 * Mesuré le 2026-08-19 (docs/DAT.md §13.12) : sous charge l'ARC atteint son
 * plafond et ne le dépasse pas. La réserve est donc à la fois nécessaire et
 * suffisante — mais seulement tant que c'est vrai. L'afficher rend la
 * vérification permanente au lieu de la laisser périmer.
 *
 * `null` n'est pas zéro : un ARC dont on ignore la taille n'est pas un ARC vide,
 * et les confondre ferait croire la réserve inutile (docs/DESIGN_SYSTEM.md
 * §14.6).
 */
export function describeArcUsage(utilise, plafond) {
  if (utilise === null || utilise === undefined) {
    return 'consommation non mesurée';
  }
  const part = plafond ? Math.round((utilise / plafond) * 100) : null;
  // Relevé à CHAQUE requête dans `arcstats`, jamais persisté (docs/DAT.md §20.1).
  // C'est ce qui lui donne sa valeur : une consommation stockée serait une valeur
  // périmée présentée comme actuelle.
  return `consomme ${formatBytes(utilise)}`
    + (part === null ? '' : ` (${part} %)`);
}

/**
 * Ce que la marge de métadonnées ajoute à l'alloué du disque (docs/DAT.md §8.8).
 *
 * Elle est invisible du LOCATAIRE — la limite d'un Spark reste ce qu'on lui a
 * vendu — mais elle grossit l'alloué du pool, donc l'exploitant la voit. Un
 * exploitant qui additionne cinq Sparks de 10 Gio et lit 50,3 Gio doit trouver
 * l'explication ici, et non dans le code.
 *
 * La valeur est LUE dans la réponse, jamais posée en dur (§27.6) : c'est un
 * réglage du serveur, et une console qui l'écrirait mentirait dès qu'il change.
 * Une marge nulle ne dit rien — il n'y a rien à expliquer.
 */
export function describeMetadataMargin(forge) {
  const marge = forge?.reserves?.storage_metadata_margin_bytes;
  if (!marge) return '';
  // Le total est LU, pas recomposé : le nombre de Sparks n'est pas dans cette
  // réponse, et le recalculer ici ferait diverger l'écran du registre.
  const total = forge?.reserves?.storage_metadata_total_bytes;
  // §1.5 bis : le CHIFFRE et le réglage qui le commande restent ; le mode de
  // panne qu'il évite est au manuel (M4, « La marge de métadonnées »).
  return `Dont ${formatBytes(marge)} de métadonnées par Spark`
    + (total ? `, soit ${formatBytes(total)} au total` : '')
    + ` · SPARKD_STORAGE_METADATA_MARGIN`;
}

/** Horodatage lisible (§3.1 pour la typographie technique). */
export function formatDate(valeur) {
  return String(valeur ?? '').slice(0, 16).replace('T', ' ');
}

/**
 * Une ressource : capacité, alloué, disponible — les TROIS, jamais deux (§27.2).
 * « 4,0 Gio libres » sans dire sur combien ne permet pas de juger s'il faut
 * supprimer un Spark ou agrandir la machine.
 */
function renderPool({ cle, nom, format, surengageable, sansFacteur }, pools,
                    complement = '') {
  const pool = pools?.[cle];
  if (!pool) {
    return `<div class="pool"><h3>${echapper(nom)}</h3>
      <p class="absence">Non relevé.</p></div>`;
  }
  const part = fillRatio(pool);
  // §27.5 : « 8,0 CPU » sur quatre cœurs promettrait du matériel qui n'existe pas.
  const facteur = surengageable && pool.overcommit && pool.overcommit !== 1
    ? ` <span class="badge badge--accent">surengagé ×${echapper(pool.overcommit)}</span>`
    : '';
  const note = [
    !surengageable && sansFacteur ? echapper(sansFacteur) : '',
    complement,
  ].filter(Boolean).map((texte) => `<p class="note">${texte}</p>`).join('');

  return `<div class="pool">
  <h3>${echapper(nom)}${facteur}</h3>
  <div class="jauge">
    <div class="jauge__piste">
      <div class="jauge__part jauge__part--reserve" style="width:${part.toFixed(1)}%"></div>
    </div>
  </div>
  <dl class="definitions definitions--serrees">
    <div class="def"><dt>Capacité</dt><dd class="technique">${echapper(format(pool.capacity))}</dd></div>
    <div class="def"><dt>Alloué</dt><dd class="technique">${echapper(format(pool.allocated))}</dd></div>
    <div class="def"><dt>Disponible</dt><dd class="technique">${echapper(format(pool.available))}</dd></div>
  </dl>
  ${note}
</div>`;
}

/**
 * La soustraction qui donne la mémoire allouable, terme à terme (§27.3, §16.1).
 *
 * Sans elle, lire « 76,2 Gio » sur une machine de 94 Gio se conclut par « il y a
 * un défaut ». Chaque terme retranché est donc nommé à l'endroit où la question
 * se pose.
 */
export function renderMemoryBreakdown(forge) {
  const total = forge?.memory?.total_bytes;
  const allouable = forge?.pools?.memory?.capacity;
  if (total == null || allouable == null) return '';

  const reserve = forge?.reserves?.memory_bytes ?? 0;
  const arc = forge?.reserves?.arc_bytes;
  const marge = forge?.reserves?.margin_bytes;

  // Les deux termes ne sont renseignés qu'à partir du relevé qui suit la
  // migration 002. Tant qu'ils valent zéro alors que la réserve ne l'est pas,
  // on n'a que la somme — on l'affiche comme telle, sans inventer la répartition.
  const detaille = (arc ?? 0) + (marge ?? 0) === reserve && reserve > 0;

  const lignes = [
    ['Mémoire de la machine', formatBytes(total), ''],
    ...(detaille
      ? [['− plafond de l’ARC ZFS', formatBytes(arc),
          // La mesure vive reste — elle change à chaque relevé, donc elle est de
          // l'écran (§1.5 bis). Le réglage la nomme ; le manuel l'explique.
          `zfs_arc_max · ${describeArcUsage(forge?.reserves?.arc_used_bytes, arc)}`],
         ['− marge d’exploitation', formatBytes(marge),
          'SPARKD_MEMORY_RESERVE']]
      : [['− réserve de la Forge', formatBytes(reserve),
          'détail connu au prochain relevé']]),
    ['= mémoire allouable', formatBytes(allouable), ''],
  ];

  return `
<section class="carte bloc" aria-labelledby="titre-memoire">
  <h2 id="titre-memoire">D’où vient la mémoire allouable</h2>
  <dl class="definitions soustraction">
    ${lignes.map(([terme, valeur, aide], i) =>
      `<div class="def${i === lignes.length - 1 ? ' def--total' : ''}">
         <dt>${echapper(terme)}${aide ? `<span class="champ__aide">${echapper(aide)}</span>` : ''}</dt>
         <dd class="technique">${echapper(valeur)}</dd>
       </div>`).join('')}
  </dl>
</section>`;
}

/**
 * Carte des cœurs (§27.4). Un Spark `dedicated` ne consomme pas de réservation :
 * il RETIRE des cœurs du pool commun. Une jauge seule masquerait exactement
 * cela — le pool rétrécirait sans qu'aucune allocation n'augmente.
 */
export function renderCores(cores, nomsParSpark = {}) {
  if (!cores) return '';
  const communs = cores.shared?.cores ?? [];
  const dedies = cores.dedicated ?? [];

  const pastille = (id, dedie) =>
    `<li class="coeur${dedie ? ' coeur--dedie' : ''}">
       <span class="coeur__id technique">cœur ${echapper(id)}</span>
       <span class="coeur__role">${dedie
         ? `dédié à ${echapper(nomsParSpark[dedie] ?? dedie)}`
         : 'pool commun'}</span>
     </li>`;

  const toutes = [
    ...communs.map((id) => ({ id, spark: null })),
    ...dedies.map((d) => ({ id: d.core_id, spark: d.spark_id })),
  ].sort((a, b) => a.id - b.id);

  return `
<section class="carte bloc" aria-labelledby="titre-coeurs">
  <h2 id="titre-coeurs">Carte des cœurs</h2>
  <ul class="coeurs">${toutes.map((c) => pastille(c.id, c.spark)).join('')}</ul>
  <p class="note">Capacité comptée en cœurs physiques.
  Un cœur dédié sort du pool commun.
  <a href="#/manuel/M4#coeurs">Manuel M4 — Les pools</a></p>
</section>`;
}

/** Pool d'adresses privées (§27.7) : il s'épuise en silence, et refuse alors
 *  une création pour une raison étrangère au CPU et à la mémoire. */
function renderAddresses(adresses) {
  if (!adresses) return '';
  return `
<section class="carte bloc" aria-labelledby="titre-adresses">
  <h2 id="titre-adresses">Adresses privées</h2>
  <dl class="definitions">
    <div class="def"><dt>Capacité</dt><dd class="technique">${echapper(adresses.capacity)}</dd></div>
    <div class="def"><dt>Attribuées</dt><dd class="technique">${echapper(adresses.used)}</dd></div>
    <div class="def"><dt>Libres</dt><dd class="technique">${echapper(adresses.free)}</dd></div>
    ${adresses.dhcp_dynamic_range
      ? `<div class="def"><dt>Plage DHCP</dt><dd class="technique">${echapper(adresses.dhcp_dynamic_range)}</dd></div>`
      : ''}
  </dl>
</section>`;
}

/** Vue complète. */
/**
 * Quel code cette Forge exécute, et comment il se situe (SPK-53, §40.3).
 *
 * @spec docs/BACKLOG.md#SPK-53 · docs/DAT.md §40.2 (« inconnue » est une
 *       réponse), §40.3 (les situations, et pourquoi les deux dernières
 *       comptent autant) · docs/DESIGN_SYSTEM.md §14.6, §9.7
 *
 * Le point à ne pas perdre : **un seul verdict affirme que tout va bien**, et
 * c'est celui qui l'a mesuré. Les autres nomment ce qu'ils savent. Une console
 * qui afficherait « à jour » faute de savoir comparer mentirait exactement au
 * moment où l'on a besoin d'elle.
 */
const TOKENS_BUILD = {
  a_jour: 'success',
  forge_en_retard: 'danger',
  poste_en_retard: 'accent',
  etrangere: 'neutral',
  non_estampillee: 'danger',
  sans_depot: 'neutral',
};

export const UPDATE_VIDE = { status: 'idle', kind: null, confirmation: null, result: null };

const PHASES_UPDATE = [
  ['package', 'Paquet'], ['units', 'Unités'], ['daemon_reload', 'daemon-reload'],
  ['restart', 'Redémarrage'], ['healthz', 'healthz'], ['readyz', 'readyz'],
  ['build', 'Build'],
];

const LIBELLES_PHASE = {
  pending: 'à faire', in_progress: 'en cours', done: 'terminée', failed: 'échec',
};

function phaseState(operation, phase) {
  if (operation.status === 'running') return phase === 'package' ? 'in_progress' : 'pending';
  const result = operation.result;
  if (!result) return 'pending';
  if (result.stages?.[phase]) {
    return result.state === 'failed' && result.stages[phase] === 'in_progress'
      ? 'failed' : result.stages[phase];
  }
  const verification = result.verification;
  if (phase === 'healthz') {
    if (!verification) return 'pending';
    return verification?.healthz?.status === 200 &&
      verification.healthz.resolvedCommit === result.target
      ? 'done' : 'failed';
  }
  if (phase === 'readyz') {
    if (!verification) return 'pending';
    return verification?.readyz?.status === 200 && verification.readyz.state === 'ready'
      ? 'done' : 'failed';
  }
  if (phase === 'build') {
    if (!verification) return 'pending';
    return verification?.build?.resolvedCommit === result.target
      ? 'done' : 'failed';
  }
  return 'pending';
}

function renderUpdateProgress(operation) {
  if (!['running', 'success', 'failed'].includes(operation.status)) return '';
  const result = operation.result;
  const rollback = operation.kind === 'rollback';
  const outcome = operation.status === 'success'
    ? `<div class="succes" role="status"><p><strong>${rollback
      ? 'Retour arrière prouvé.' : 'Mise à jour prouvée.'}</strong>
       La Forge sert <span class="technique">${echapper(result.target?.slice(0, 12))}</span>
       et ses dépendances répondent.</p>${result.journaled === false
         ? '<p>La build est prouvée, mais son inscription au journal a échoué.</p>' : ''}</div>`
    : operation.status === 'failed'
      ? `<div class="refus" role="alert"><p><strong>${rollback
        ? 'Retour arrière en échec.' : 'Mise à jour en échec.'}</strong>
         ${echapper(result?.message ?? 'Les preuves distantes ne concordent pas.')}</p>
         ${result?.rollback
           ? `<p>Retour arrière : ${result.rollback.state === 'success'
             ? `build précédente rétablie et prouvée (${echapper(result.rollback.target?.slice(0, 12))}).`
             : `échec — ${echapper(result.rollback.message ?? result.rollback.error)}.`}</p>` : ''}</div>`
      : '';
  return `
  <div class="progression" role="status"${operation.status === 'running'
    ? ' aria-busy="true"' : ''}>
    <ol>${PHASES_UPDATE.map(([phase, label]) => {
      const state = phaseState(operation, phase);
      return `<li><span>${label}</span> <strong>${LIBELLES_PHASE[state] ?? state}</strong></li>`;
    }).join('')}</ol>
  </div>
  ${outcome}`;
}

function renderUpdateActions(build, operation) {
  if (operation.confirmation === 'update') {
    return `<div class="confirmation confirmation--sensible" role="group"
      aria-labelledby="titre-confirmation-update">
      <h3 id="titre-confirmation-update">Mettre à jour sparkd ?</h3>
      <p>L’API du plan de contrôle sera brièvement interrompue. La build
      <span class="technique">${echapper((build.forgeCommit ?? build.forge?.commit)?.slice(0, 12))}</span>
      sera remplacée par <span class="technique">${echapper(build.local?.head?.slice(0, 12))}</span>.</p>
      <p class="formulaire__actions">
        <button type="button" class="bouton" data-action="confirmer-update">Mettre à jour sparkd</button>
        <button type="button" class="bouton bouton--secondaire" data-action="annuler-update">Annuler</button>
      </p>
    </div>`;
  }
  if (operation.confirmation === 'rollback') {
    return `<div class="confirmation confirmation--sensible" role="group"
      aria-labelledby="titre-confirmation-rollback">
      <h3 id="titre-confirmation-rollback">Revenir à la build précédente ?</h3>
      <p>Le code régressera de
      <span class="technique">${echapper(build.rollback?.current?.slice(0, 12))}</span>
      à <span class="technique">${echapper(build.rollback?.previous?.slice(0, 12))}</span>
      et l’API sera de nouveau brièvement interrompue.</p>
      <p class="formulaire__actions">
        <button type="button" class="bouton" data-action="confirmer-rollback">Revenir à cette build</button>
        <button type="button" class="bouton bouton--secondaire" data-action="annuler-update">Annuler</button>
      </p>
    </div>`;
  }
  if (operation.status === 'running') return '';
  const actions = [
    build.update?.allowed
      ? '<button type="button" class="bouton" data-action="demander-update">Mettre à jour sparkd</button>' : '',
    build.rollback?.available
      ? '<button type="button" class="bouton" data-action="demander-rollback">Revenir à la build précédente</button>' : '',
    '<button type="button" class="bouton bouton--compact" data-action="comparer-build">Comparer à nouveau</button>',
  ].filter(Boolean).join('\n');
  return `<p class="formulaire__actions">${actions}</p>
    ${build.verdict === 'forge_en_retard' && build.update && !build.update.allowed
      ? `<p class="note">Mise à jour indisponible : ${echapper(build.update.reason)}</p>` : ''}`;
}

export function renderBuild(build, operation = UPDATE_VIDE) {
  // §14.6 : « pas encore relevé » n'est ni « à jour », ni une panne. Tant que la
  // console n'a pas comparé, elle ne dit rien plutôt qu'une supposition.
  if (!build) {
    return `
<section class="carte bloc" aria-labelledby="titre-build">
  <h2 id="titre-build">Code déployé</h2>
  <p class="absence">La console n’a pas encore comparé le code de cette Forge
  à celui de ce poste.</p>
</section>`;
  }
  if (build === 'en-cours') {
    return `
<section class="carte bloc" aria-labelledby="titre-build">
  <h2 id="titre-build">Code déployé</h2>
  <p class="note" role="status" aria-busy="true">Comparaison en cours…</p>
</section>`;
  }

  const token = TOKENS_BUILD[build.verdict] ?? 'neutral';
  const grave = token === 'danger';
  const chiffre = build.behind ? ` — ${build.behind} commit${build.behind > 1 ? 's' : ''} d’écart`
    : build.ahead ? ` — ${build.ahead} commit${build.ahead > 1 ? 's' : ''} d’avance sur ce poste`
      : '';

  // La version est une donnée technique : elle se compare caractère par
  // caractère, donc elle est en chasse fixe (§3.1). Elle n'est PAS le verdict.
  const version = build.forge?.version
    ? `<div class="def"><dt>Version installée</dt>
         <dd><span class="technique">${echapper(build.forge.version)}</span>${
           build.forge.dirty
             ? ' <span class="badge badge--accent">arbre modifié</span>' : ''}</dd></div>`
    : '';

  return `
<section class="carte bloc" aria-labelledby="titre-build">
  <h2 id="titre-build">Code déployé</h2>
  <div class="${grave ? 'refus' : 'definitions'}"${grave ? ' role="alert"' : ''}>
    <p><span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${
      echapper(build.titre ?? build.verdict)}</span>${echapper(chiffre)}</p>
    <p>${echapper(build.detail ?? '')}</p>
  </div>
  <div class="definitions">
    ${version}
    ${build.local?.head
      ? `<div class="def"><dt>Dépôt de ce poste</dt>
           <dd><span class="technique">${echapper(build.local.head.slice(0, 12))}</span>
           ${build.local.branch ? `sur ${echapper(build.local.branch)}` : ''}</dd></div>`
      : ''}
  </div>
  ${renderUpdateProgress(operation)}
  ${renderUpdateActions(build, operation)}
</section>`;
}

/**
 * Ce que le canal hors bande a fait, ou n'a pas pu faire.
 *
 * @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.6 (l'échec est DIT), §47.3
 *       (absente, la fonction se désactive et ce n'est pas une panne), §47.7
 *       (ce qu'elle ne prétend pas) · docs/DESIGN_SYSTEM.md §14.5 (une absence
 *       se NOMME), §14.6 (zéro n'est pas « rien à signaler »), §25.1 (le rouge
 *       est réservé au refus du serveur)
 *
 * **Le point qui décide de ce bloc** : sans canal, les compteurs valent zéro — et
 * zéro ressemble à « tout va bien ». Il faut donc dire l'inverse en toutes
 * lettres : rien n'est surveillé. C'est exactement le §14.6.
 *
 * En ACCENT et jamais en rouge quand des envois échouent : la Forge n'a rien
 * refusé, les gestes ont abouti. Ce qui manque est la détection, pas l'action.
 */
export function renderNotify(notify) {
  // §14.5 : une Forge qui ne rend pas encore ce champ n'est pas une Forge sans
  // canal. Ne rien affirmer vaut mieux qu'affirmer faux.
  if (!notify) return '';

  const entete = '<h2 id="titre-notify">Alerte hors bande</h2>';

  if (!notify.configured) {
    return `
<section class="carte bloc" aria-labelledby="titre-notify">
  ${entete}
  <p class="absence"><strong>Aucun canal n’est configuré</strong> : aucune alerte
  n’est envoyée lorsqu’un Spark est supprimé, qu’une protection est levée ou
  qu’un accès est donné. Ce n’est pas une panne — la Forge fonctionne — mais rien
  n’est surveillé.</p>
  <p class="note"><a href="#/manuel/M11">Manuel M11 — Sécurité et limites</a></p>
</section>`;
  }

  const echecs = Number(notify.failed ?? 0) + Number(notify.dropped ?? 0);
  const bilan = echecs > 0
    ? `<p class="avertissement" role="status"><strong>${echapper(String(echecs))} alerte(s)
       ne sont pas parties.</strong> Les gestes, eux, ont abouti : un canal muet
       n’empêche jamais d’agir. ${notify.last_error
         ? `Dernier motif : ${echapper(notify.last_error)}.` : ''}</p>`
    : `<p class="succes">Toutes les alertes sont parties.</p>`;

  return `
<section class="carte bloc" aria-labelledby="titre-notify">
  ${entete}
  ${bilan}
  <div class="definitions">
    <div class="def"><dt>Envoyées</dt><dd>${echapper(String(notify.sent ?? 0))}</dd></div>
    <div class="def"><dt>En échec</dt><dd>${echapper(String(notify.failed ?? 0))}</dd></div>
    <div class="def"><dt>Abandonnées</dt><dd>${echapper(String(notify.dropped ?? 0))}</dd></div>
  </div>
  <p class="note">Ces compteurs repartent de zéro à chaque redémarrage du
  serveur : ils disent ce qui s’est passé depuis, pas depuis toujours.</p>
</section>`;
}

export function renderForgeView({ status = 'loading', host = null, cores = null,
                                 sparkNames = {}, error = null,
                                 build = null, syncing = false,
                                 installer = null, updateUi = UPDATE_VIDE } = {}) {
  // SPK-68 · §50.1 : l'assistant doit rester visible quand /healthz manque ;
  // le cacher derrière l'erreur du plan de contrôle rendrait son cas d'usage
  // inatteignable.
  if (status === 'loading') return renderHostSkeleton() + renderForgeInstaller(installer);
  if (status === 'not-synced') return renderNotSynced(error, syncing) + renderForgeInstaller(installer);
  if (status === 'error') return renderHostError(error) + renderForgeInstaller(installer);
  if (!host) return renderHostError(null) + renderForgeInstaller(installer);

  const garantie = GARANTIES[host.reservation_guarantee];

  return `
<header class="entete-entite">
  <div class="entete-entite__identite">
    <h1>Ressources de la Forge</h1>
    ${host.hostname ? `<span class="technique">${echapper(host.hostname)}</span>` : ''}
  </div>
  <p class="note">Relevé le
    <span class="technique">${echapper(formatDate(host.topology_synced_at)) || 'jamais'}</span>.
    La capacité n’est pas rafraîchie à chaque requête.
    <button type="button" class="bouton bouton--compact" data-action="relever"
      ${syncing ? 'disabled' : ''}>${syncing ? 'Relevé…' : 'Relever à nouveau'}</button>
  </p>
</header>
<section class="carte bloc" aria-labelledby="titre-pools">
  <h2 id="titre-pools">Pools</h2>
  <div class="pools">${RESSOURCES.map((r) =>
    renderPool(r, host.pools, r.cle === 'storage' ? describeMetadataMargin(host) : '')).join('')}</div>
  ${garantie ? `<p class="avertissement" role="status">${echapper(garantie)}</p>` : ''}
</section>
<div class="detail">
  <div class="detail__principal">
    ${renderMemoryBreakdown(host)}
    ${renderCores(cores, sparkNames)}
  </div>
  <div class="detail__secondaire">
    ${renderBuild(build, updateUi)}
    ${renderNotify(host.notify)}
    ${renderAddresses(host.addresses)}
  </div>
</div>
${renderForgeInstaller(installer)}`;
}

export function renderHostSkeleton() {
  return `
<div class="carte bloc" aria-busy="true">
  <p class="sr-only" role="status">Relevé de la Forge en cours…</p>
  ${Array.from({ length: 4 }, (_, i) =>
    `<span class="squelette" style="display:block;width:${70 - i * 8}%;margin-bottom:var(--space-3)"></span>`).join('')}
</div>`;
}

/**
 * §27.8 : une topologie jamais relevée n'est pas une panne, c'est une machine
 * qu'on n'a pas encore interrogée. Le remède est offert comme une ACTION.
 */
export function renderNotSynced(error, syncing = false) {
  return `
<div class="carte"><div class="etat-vue">
  <h2>La topologie de cette Forge n’a pas encore été relevée</h2>
  <p>${echapper(error?.message ?? 'Le registre ne connaît pas encore la capacité de la machine.')}</p>
  <p style="margin-top:var(--space-4)">
    <button type="button" class="bouton bouton--primaire" data-action="relever"
      ${syncing ? 'disabled' : ''}>${syncing ? 'Relevé…' : 'Relever la topologie'}</button>
  </p>
</div></div>`;
}

export function renderHostError(error) {
  return `
<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
  <h2>Les ressources de la Forge n’ont pas pu être lues</h2>
  <p>${echapper(error?.message ?? 'Cause inconnue.')}</p>
  <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
</div></div>`;
}
