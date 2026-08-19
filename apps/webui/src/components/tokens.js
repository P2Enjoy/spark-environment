/**
 * Correspondances entre données métier et tokens visuels.
 *
 * @spec docs/DESIGN_SYSTEM.md §12.5 (les correspondances vivent à un seul
 *       endroit), §2.6 (repli documenté pour une valeur inconnue) ·
 *       docs/DESIGN_SYSTEM_APP.md §4 (SPK-DS-01, SPK-DS-03)
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
