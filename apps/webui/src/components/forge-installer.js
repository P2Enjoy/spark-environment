/**
 * Assistant de diagnostic d'une Forge distante.
 *
 * @spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.1-§50.4 ·
 *       docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 */

const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const INSTALLER_VIDE = {
  status: 'idle', result: null, error: null, plan: null, planError: null,
  values: { poolName: 'spark', bridgeName: 'sparkbr0', cpuReserve: '0.5',
    memoryReserveGib: '2', arcMaxGib: '16', storageKind: 'file',
    filePoolSizeGib: '', rootReserveGib: '' },
};

function bytes(value) {
  if (!Number.isFinite(value)) return 'inconnu';
  if (value < 1024) return `${value} o`;
  const units = ['Kio', 'Mio', 'Gio', 'Tio'];
  let number = value;
  let unit = 'o';
  for (const next of units) {
    number /= 1024;
    unit = next;
    if (number < 1024) break;
  }
  return `${number.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${unit}`;
}

function badge(token, text) {
  return `<span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${
    echapper(text)}</span>`;
}

function definition(term, value) {
  return `<div class="def"><dt>${echapper(term)}</dt><dd>${echapper(value ?? 'inconnu')}</dd></div>`;
}

function transport(result) {
  const report = result.report;
  const active = report.services?.sparkd === 'active';
  const sparkdPresent = Boolean(report.runtimes?.sparkd) || active;
  const api = active
    ? ['accent', 'installé, API à vérifier']
    : sparkdPresent
      ? ['accent', `installé, unité ${report.services?.sparkd ?? 'inconnue'}`]
      : ['accent', 'sans réponse ou non installé'];
  return `
<section class="installation__etat" aria-label="État constaté">
  <div>${badge('success', 'SSH établi')}<p>Le relevé SSH s’est terminé ; cela ne prouve pas encore l’API.</p></div>
  <div>${badge(...api)}<p>La Forge n’est jamais dite prête sur la seule base du transport.</p></div>
</section>`;
}

function storage(storage) {
  const disks = storage?.disks ?? [];
  const rows = disks.length ? disks.map((disk) => `
    <tr><td class="technique">/dev/${echapper(disk.name)}</td><td>${echapper(bytes(disk.sizeBytes))}</td>
      <td>${disk.reasons?.length
        ? echapper(disk.reasons.join(' · '))
        : 'support libre à confirmer'}</td></tr>`).join('')
    : '<tr><td colspan="3">Aucun périphérique bloc exploitable n’a été relevé.</td></tr>';
  const mirror = storage?.nativeMirror?.eligible
    ? `<p class="avertissement" role="status">Deux supports libres sont détectés :
       <span class="technique">${echapper(storage.nativeMirror.disks.map((d) => `/dev/${d}`).join(', '))}</span>.
       Ils ne seront jamais effacés sans confirmation séparée.</p>`
    : `<p class="note">Aucune paire de disques sûre n’est proposée. Le pool fichier
       reste envisageable sur ${storage?.filePool?.availableBytes == null
         ? 'un espace non mesuré'
         : `${bytes(storage.filePool.availableBytes)} libres`}, mais sa taille n’est pas devinée.</p>`;
  return `
<section class="carte bloc installation__stockage" aria-labelledby="titre-installation-stockage">
  <h3 id="titre-installation-stockage">Stockage relevé</h3>
  <div class="tableau-defilant"><table><thead><tr><th scope="col">Support</th>
    <th scope="col">Taille</th><th scope="col">Décision</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  ${mirror}
</section>`;
}

function resultView(result) {
  const report = result.report;
  return `
  ${transport(result)}
  <section class="installation__releve" aria-labelledby="titre-installation-releve">
    <h3 id="titre-installation-releve">Relevé initial</h3>
    <dl class="definitions">
      ${definition('Système', report.system?.os)}
      ${definition('Architecture', report.system?.architecture)}
      ${definition('Droit d’administration', report.access?.sudo)}
      ${definition('Incus', report.runtimes?.incus)}
      ${definition('Caddy', report.runtimes?.caddy)}
      ${definition('Unité sparkd', report.services?.sparkd)}
      ${definition('Espace disponible sur /', bytes(report.system?.rootAvailableBytes))}
    </dl>
  </section>
  ${storage(result.storage)}
  <p class="note">Ce relevé est strictement en lecture seule. Il ne lance pas
  l’installation, ne crée pas de pool et ne change aucun service.</p>`;
}

function planForm(installer) {
  const result = installer.result;
  const values = { ...INSTALLER_VIDE.values, ...(installer.values ?? {}) };
  const existingPool = (result.report?.pools ?? []).some((line) =>
    String(line).split(',')[0] === values.poolName && String(line).split(',')[1] === 'zfs');
  const native = result.storage?.nativeMirror?.eligible;
  const storageChoice = existingPool
    ? `<p class="succes">Le pool ZFS « ${echapper(values.poolName)} » sera conservé.</p>`
    : native
      ? `<fieldset><legend>Disposition de stockage</legend>
          <label><input type="radio" name="storageKind" value="native"${
            values.storageKind === 'native' ? ' checked' : ''}> Miroir natif sur ${echapper(
              result.storage.nativeMirror.disks.map((d) => `/dev/${d}`).join(' et '))}</label>
          <label><input type="radio" name="storageKind" value="file"${
            values.storageKind !== 'native' ? ' checked' : ''}> Pool sur fichier</label>
        </fieldset>`
      : `<input type="hidden" name="storageKind" value="file">
         <p class="note">Aucune paire sûre : seule la disposition sur fichier peut être planifiée.</p>`;
  const fileFields = existingPool ? '' : `
    <div class="installation__dimensions">
      <label>Taille du pool fichier (Gio)
        <input class="controle" name="filePoolSizeGib" type="number" min="0.1" step="0.1"
          value="${echapper(values.filePoolSizeGib)}" required></label>
      <label>Espace à laisser libre sur / (Gio)
        <input class="controle" name="rootReserveGib" type="number" min="0" step="0.1"
          value="${echapper(values.rootReserveGib)}" required></label>
    </div>`;
  return `${installer.planError ? `<div class="refus" role="status">${
    echapper(installer.planError)}</div>` : ''}<form id="formulaire-plan-forge" class="formulaire-panneau installation__plan">
    <h3>Plan d’installation</h3>
    <p class="note">Les valeurs ci-dessous viennent du contrat de déploiement ; elles restent
      modifiables avant l’engagement.</p>
    <div class="installation__dimensions">
      <label>Pool <input class="controle" name="poolName" value="${echapper(values.poolName)}" required></label>
      <label>Bridge <input class="controle" name="bridgeName" value="${echapper(values.bridgeName)}" required></label>
      <label>Réserve CPU <input class="controle" name="cpuReserve" type="number" min="0" step="0.1"
        value="${echapper(values.cpuReserve)}" required></label>
      <label>Réserve mémoire (Gio) <input class="controle" name="memoryReserveGib" type="number" min="0" step="0.1"
        value="${echapper(values.memoryReserveGib)}" required></label>
      <label>Plafond ARC (Gio) <input class="controle" name="arcMaxGib" type="number" min="0" step="0.1"
        value="${echapper(values.arcMaxGib)}" required></label>
    </div>
    ${storageChoice}${fileFields}
    <button type="submit" class="bouton"${installer.status === 'planning' ? ' disabled' : ''}>${
      installer.status === 'planning' ? 'Nouveau relevé…' : 'Vérifier et composer le plan'}</button>
  </form>`;
}

function planView(plan) {
  if (!plan) return '';
  const storageText = plan.storage.kind === 'reuse'
    ? `conserver le pool « ${plan.storage.poolName} »`
    : plan.storage.kind === 'native'
      ? `créer le miroir sur ${plan.storage.devices.join(' et ')}`
      : `créer ${plan.storage.sizeGib} Gio dans ${plan.storage.path} et conserver ${plan.storage.reserveGib} Gio libres`;
  return `<section class="progression" aria-labelledby="titre-plan-valide">
    <h3 id="titre-plan-valide">Plan vérifié sur un nouveau relevé</h3>
    <p><strong>Stockage :</strong> ${echapper(storageText)}.</p>
    <ol>${plan.phases.map((phase) => `<li><strong>${echapper(phase.label)}</strong> — ${
      phase.status === 'done' ? 'terminée' : 'à faire'}</li>`).join('')}</ol>
    <p class="avertissement">Aucune écriture n’a encore eu lieu. L’exécution restera impossible
      jusqu’à la confirmation séparée de ce plan par l’installateur versionné.</p>
  </section>`;
}

/** Panneau présent même si /healthz est absent : c'est son cas d'usage. */
export function renderForgeInstaller(installer = INSTALLER_VIDE) {
  // `null` est la valeur qu'une vue parente emploie tant que son état n'est pas
  // initialisé : elle signifie le même « pas encore lancé » que `undefined`.
  installer = installer ?? INSTALLER_VIDE;
  const running = ['running', 'planning'].includes(installer.status);
  const content = running
    ? '<p role="status" aria-busy="true">Diagnostic SSH en cours…</p>'
    : installer.status === 'error'
      ? `<div class="avertissement" role="status"><p><strong>Diagnostic impossible.</strong>
         ${echapper(installer.error ?? 'Cause inconnue.')}</p><p>La Forge n’a reçu aucune
         commande d’installation.</p></div>`
      : ['ready', 'planning', 'planned'].includes(installer.status) && installer.result
        ? resultView(installer.result) + planForm(installer) + planView(installer.plan)
        : `<p>Cette destination peut accepter SSH sans encore porter ` + '`sparkd`' + `.
           Le diagnostic distingue ces deux faits avant toute décision de stockage.</p>`;
  return `
<section class="carte bloc installation" aria-labelledby="titre-installation">
  <div class="installation__entete"><div><h2 id="titre-installation">Installer cette Forge</h2>
    <p class="note">Assistant de préparation — aucune écriture distante sans un plan confirmé.</p></div>
    <button type="button" class="bouton bouton--compact" data-action="diagnostiquer-forge"
      ${running ? 'disabled' : ''}>${running ? 'Diagnostic…' : 'Diagnostiquer la Forge'}</button>
  </div>
  ${content}
  ${['ready', 'planned'].includes(installer.status) ? `<p class="note">L’exécution du plan reste
  désactivée tant que son installateur versionné et ses confirmations de stockage
  ne sont pas livrés. Ce panneau ne simule aucun succès.</p>` : ''}
</section>`;
}
