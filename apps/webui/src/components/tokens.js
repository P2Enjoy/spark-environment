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
  stopped: "Arrêté — aucune mesure d'exécution",
  pending: 'Mesure en cours',
  unavailable: 'Indisponible',
};

const OCTETS = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];

/** Formate des octets. `null` reste `null` : ce n'est pas zéro (§14.6). */
export function formatBytes(value) {
  if (value === null || value === undefined) return null;
  let n = value;
  let i = 0;
  while (n >= 1024 && i < OCTETS.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${OCTETS[i]}`;
}

export function formatBps(value) {
  if (value === null || value === undefined) return null;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} Gbit/s`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} Mbit/s`;
  return `${Math.round(value / 1e3)} kbit/s`;
}

/** Formate une part de CPU. Distingue explicitement l'inconnu de zéro. */
export function formatCpu(value) {
  if (value === null || value === undefined) return null;
  return value.toFixed(value < 1 ? 2 : 1);
}
