/**
 * Correspondances entre données métier et tokens visuels.
 *
 * @spec docs/DESIGN_SYSTEM.md §12.5 (les correspondances vivent à un seul
 *       endroit), §2.6 (repli documenté pour une valeur inconnue) ·
 *       docs/DESIGN_SYSTEM_APP.md §4 (SPK-DS-01, SPK-DS-03)
 * @spec docs/BACKLOG.md#SPK-46 · docs/DAT.md §21.5 bis (le vocabulaire du
 *       journal, et qui le traduit) · docs/DESIGN_SYSTEM.md §14.7 — pour
 *       `traduireMessage`, qui vit ICI parce que deux surfaces l'emploient.
 *
 * Un composant ne possède pas sa propre copie de ces tables.
 */

/** États d'un Spark (docs/SCHEMA.md §4). `transient` : aucune commande n'y est
 *  acceptée par le runtime, et l'interface doit le faire comprendre. */
export const SPARK_STATES = {
  running:  { token: 'success', label: 'En marche',       transient: false },
  stopped:  { token: 'neutral', label: 'Arrêté',          transient: false },
  pending:  { token: 'accent',  label: 'En attente',      transient: false },
  error:    { token: 'danger',  label: 'En erreur',       transient: false },
  creating: { token: 'brand',   label: 'Création…',       transient: true },
  starting: { token: 'brand',   label: 'Démarrage…',      transient: true },
  stopping: { token: 'brand',   label: 'Arrêt…',          transient: true },
  deleting: { token: 'brand',   label: 'Suppression…',    transient: true },
};

/** Repli documenté (§2.6) : une valeur inconnue du backend ne devient jamais
 *  `undefined` à l'écran (§14.7). */
export const UNKNOWN_STATE = { token: 'neutral', label: 'État inconnu', transient: false };

export function stateOf(value) {
  return SPARK_STATES[value] ?? { ...UNKNOWN_STATE, label: `État inconnu (${value ?? '—'})` };
}

/** Textes d'absence de mesure (§14.6, SPK-DS-03) : zéro, mesure en cours et
 *  mesure impossible ne sont jamais confondus. */
export const MEASURE = {
  stopped: "Arrêté — aucune mesure d’exécution",
  // Un premier relevé EN COURS : la mesure arrive.
  pending: 'Mesure en cours',
  // Un Spark DÉCLARÉ mais pas encore appliqué n'a jamais tourné : il n'y a
  // rien à mesurer, et annoncer « Mesure en cours » ferait attendre une valeur
  // qui ne viendra pas (docs/DESIGN_SYSTEM.md §14.6 — ne jamais confondre un
  // calcul en cours avec une donnée inexistante).
  declared: 'Pas encore appliqué — rien à mesurer',
  unavailable: 'Indisponible',
};

/**
 * États d'un tunnel, en français. Défini À UN SEUL ENDROIT.
 *
 * Le badge d'en-tête et le bandeau d'alerte rendaient le même état avec deux
 * vocabulaires : « rompu » d'un côté, « broken » de l'autre, à quelques
 * centimètres. Une valeur technique brute ne doit pas atteindre l'écran
 * (docs/DESIGN_SYSTEM.md §14.7).
 */
export const TUNNEL_STATES = {
  ready: { label: 'ouvert', token: 'success' },
  connecting: { label: 'en cours', token: 'brand' },
  broken: { label: 'rompu', token: 'danger' },
  closed: { label: 'fermé', token: 'neutral' },
};

export function tunnelOf(value) {
  return TUNNEL_STATES[value] ?? { label: String(value ?? 'inconnu'), token: 'neutral' };
}

/** Deux vérités SPK-68 : transport SSH et plan de contrôle ne partagent pas un verdict. */
export function tunnelContextOf(tunnel) {
  if (tunnel?.state === 'broken' && tunnel?.transportState === 'ready') {
    return { label: 'SSH établi · sparkd sans réponse', token: 'accent', reconnect: false };
  }
  const state = tunnelOf(tunnel?.state ?? 'closed');
  return { label: `Tunnel ${state.label}`, token: state.token,
           reconnect: tunnel?.state === 'broken' };
}

const OCTETS = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];

/** Le produit est en français : la virgule est le séparateur décimal.
 *  Un point ferait lire « 2.0 Gio » comme un anglicisme dans une interface
 *  entièrement francophone (docs/DESIGN_SYSTEM.md §11). */
const virgule = (texte) => String(texte).replace('.', ',');

/** Formate des octets. `null` reste `null` : ce n'est pas zéro (§14.6). */
export function formatBytes(value) {
  if (value === null || value === undefined) return null;
  let n = value;
  let i = 0;
  while (n >= 1024 && i < OCTETS.length - 1) { n /= 1024; i += 1; }
  return `${virgule(n < 10 && i > 0 ? n.toFixed(1) : Math.round(n))} ${OCTETS[i]}`;
}

/**
 * Octets d'un QUOTA qu'on règle, par opposition à une mesure qu'on lit.
 *
 * @spec docs/BACKLOG.md#SPK-59 · docs/DESIGN_SYSTEM.md §6.9 bis (la valeur
 *       affichée est exacte sur la grille du curseur) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-07 (la mémoire au pas de 256 Mio)
 *
 * `formatBytes` arrondit, et il a raison de le faire : la dernière décimale
 * d'une mesure n'apprend rien. Un quota, lui, est la valeur qui SERA envoyée.
 * Mesuré sur le pas de 256 Mio : `formatBytes` rend « 1,3 Gio » pour 1,25 et
 * « 10 Gio » pour 10,25 — trois crans sur quatre deviennent invisibles, on
 * déplace la poignée et le chiffre ne bouge pas.
 *
 * Deux décimales suffisent et ne mentent pas : les pas du produit sont des
 * quarts de gibioctet ou des unités entières. Les zéros inutiles tombent, pour
 * que « 2 Gio » ne s'écrive pas « 2,00 Gio ».
 */
export function formatOctetsExact(value) {
  if (value === null || value === undefined) return null;
  let n = value;
  let i = 0;
  while (n >= 1024 && i < OCTETS.length - 1) { n /= 1024; i += 1; }
  return `${virgule(String(Number(n.toFixed(2))))} ${OCTETS[i]}`;
}

export function formatBps(value) {
  if (value === null || value === undefined) return null;
  if (value >= 1e9) return `${virgule((value / 1e9).toFixed(1))} Gbit/s`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} Mbit/s`;
  return `${Math.round(value / 1e3)} kbit/s`;
}

/**
 * Formate une part de CPU. Distingue explicitement l'inconnu de zéro.
 *
 * La précision est FIXE : « 2.0 sur 0.50 » juxtaposait deux précisions dans une
 * même phrase et se lisait mal. Deux décimales partout, virgule française.
 */
export function formatCpu(value) {
  if (value === null || value === undefined) return null;
  return virgule(value.toFixed(2));
}

/* ------------------------------------------ ce qui est parti sans signature */

/**
 * Ce qu'un geste NON SIGNÉ dit à l'exploitant, motif par motif.
 *
 * @spec docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.10.8 (les motifs et ce qu'ils
 *       doivent faire faire), §36.10.9 (le motif voyage en jeton, la phrase
 *       reste ici) · docs/DESIGN_SYSTEM.md §12.5 (une table, un seul endroit),
 *       §14.7 (aucun jeton technique à l'écran)
 *
 * Le relais rend un JETON — `sans_cle`, `agent_muet`, `echec_signature` — parce
 * qu'un en-tête HTTP ne transporte pas d'accent. La phrase vit ICI, et une
 * preuve garde que cette table couvre exactement les motifs de
 * `apps/webui/host/signature.js` : un motif sans phrase serait un échec TU,
 * précisément ce que le §36.10.8 interdit.
 *
 * Chaque phrase dit DEUX choses : que le geste a bien eu lieu — il ne faut pas
 * le refaire —, et quoi faire pour que le suivant soit signé.
 */
export const SIGNATURE_MOTIFS = {
  sans_cle: 'Aucune clé de signature n’est configurée pour ce serveur : ce geste '
    + 'a bien eu lieu, mais il est parti sans signature et le journal ne pourra '
    + 'pas prouver qu’il a été demandé.',
  agent_muet: 'Aucun agent ne détient la clé de signature de ce serveur : ce '
    + 'geste a bien eu lieu, mais il est parti sans signature. Chargez la clé '
    + 'dans votre agent — « ssh-add » — pour que les suivants soient signés.',
  echec_signature: 'La signature n’a pas pu être produite : ce geste a bien eu '
    + 'lieu, mais il est parti sans elle.',
};

/**
 * Repli documenté (§2.6) : un motif que la console ne connaît pas se DIT quand
 * même. Le taire ferait disparaître l'avertissement au moment précis où l'on ne
 * sait pas ce qui s'est passé — le §36.10.8 veut l'inverse.
 */
export function signatureMotifOf(jeton) {
  if (!jeton) return null;
  return SIGNATURE_MOTIFS[jeton]
    ?? 'Ce geste a bien eu lieu, mais la console n’a pas pu le signer.';
}

/* ------------------------------------------------ traduction des messages */

/**
 * Traduit à l'AFFICHAGE le vocabulaire technique d'un message du serveur.
 *
 * @spec docs/BACKLOG.md#SPK-46 · docs/DAT.md §21.5 bis · docs/DESIGN_SYSTEM.md §14.7
 *
 * Le journal reste un enregistrement TECHNIQUE : `sparkd` continue d'y écrire
 * « starting » → « running », qui est ce que le runtime a réellement fait. Y
 * écrire du vocabulaire d'interface le rendrait moins précis pour gagner en
 * confort, et au mauvais endroit — le journal sert aussi au diagnostic.
 *
 * **Elle ne devine jamais.** Seules les formes que la console SAIT reconnaître
 * sont traduites ; tout le reste traverse INTACT. Un message inconnu mal
 * traduit serait pire que le même message resté technique.
 */

/** Les états cités entre guillemets français dans un message du runtime. */
const CITATION = /«\s*([a-z_-]+)\s*»/g;

/** Les états de tunnel cités entre parenthèses par l'hôte console (§22.3). */
const ETAT_TUNNEL = /\((broken|ready|connecting|closed)\b/g;

export function traduireMessage(texte) {
  const brut = String(texte ?? '');
  if (!brut) return brut;
  return brut
    // Un état de Spark cité : on ne remplace QUE si la table le connaît.
    // `SPARK_STATES[x]` et non `stateOf(x)` : `stateOf` fabrique un repli
    // « État inconnu (…) », qui déformerait un mot qui n'est pas un état.
    .replace(CITATION, (entier, mot) =>
      SPARK_STATES[mot] ? `« ${SPARK_STATES[mot].label} »` : entier)
    // Un état de tunnel, même règle : le registre signalait ce message comme
    // le même écart — le badge disait « rompu » quand le texte disait « broken ».
    .replace(ETAT_TUNNEL, (entier, mot) =>
      TUNNEL_STATES[mot] ? `(${TUNNEL_STATES[mot].label}` : entier);
}
