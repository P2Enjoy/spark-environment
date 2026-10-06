/**
 * Épreuve sur la VM du banc : la `sparkd` fraîchement installée refuse le mode
 * mémoire « souple » à la création.
 *
 * @verifies docs/BACKLOG.md#SPK-146 · docs/DAT.md §7.6 (la mémoire est un plafond
 *           strict ; la création refuse `memory_enforce=soft`)
 *
 * Une règle de l'API, sans écran : elle se constate par un appel direct à la
 * `sparkd` de la VM — pas par la console, qui n'offre pas ce choix.
 */

export default async function jouer({ api, verdict }) {
  const corps = {
    name: 'epreuve-memoire', image: 'images:ubuntu/24.04', cpu_mode: 'shared',
    cpu_reservation: 0.25, memory_bytes: 256 * 1024 ** 2, storage_bytes: 1024 ** 3,
    network_bps: 10_000_000, memory_enforce: 'soft' };
  const refus = api('POST', '/v1/sparks', corps);
  const detail = refus.detail ?? {};
  verdict('SPK-146 : la création refuse le mode mémoire souple, en le nommant',
          detail.error === 'quota_incoherent' && detail.field === 'memory_enforce',
          detail.message ?? JSON.stringify(refus).slice(0, 200));
  const existe = (api('GET', '/v1/sparks').sparks ?? []).some((s) => s.name === corps.name);
  verdict('SPK-146 : rien n’a été créé', !existe, existe ? 'créé à tort' : 'absent');
}
