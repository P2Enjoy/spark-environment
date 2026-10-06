/**
 * Les canaux d'alerte hors bande, réglés depuis la Forge.
 *
 * @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (deux canaux au registre),
 *       §47.3.0 bis (l'onglet, et pourquoi il est une destination),
 *       §47.3.1 (le gabarit et ses trois règles), §47.3.3 (le mot de passe à
 *       CHAQUE écriture), §47.6 (l'échec est dit), §14.6 (zéro ne veut pas dire
 *       « tout va bien »), §43.3 (un secret ne s'affiche pas) ·
 *       docs/DESIGN_SYSTEM.md §6.13 (états systématiques), §1.5 bis (laisser
 *       tenter, montrer le refus réel)
 *
 * Une section de la FORGE, jamais une facette d'un Spark : un canal d'alerte
 * décrit la Forge entière, et les gestes qu'il rapporte portent sur n'importe
 * lequel de ses Sparks.
 *
 * **Aucun bouton « essayer le canal ».** Le §47.3.0 bis en donne la raison : une
 * alerte hors bande sert à DÉTECTER, et un canal qu'on peut faire parler sur
 * commande apprend à son destinataire que certains messages ne comptent pas.
 * @spec docs/BACKLOG.md#SPK-136 · docs/DESIGN_SYSTEM.md §12.3 (toute classe écrite
 *       peint quelque chose ; un crochet de script est un attribut `data-*`)
 * @spec docs/BACKLOG.md#SPK-140 · docs/DAT.md §47.3.0 bis · docs/DESIGN_SYSTEM.md
 *       §6.11, §7.1 (un refus garde la saisie, sauf le mot de passe)
 * @spec docs/BACKLOG.md#SPK-147 · docs/DAT.md §47.3.1 (l'aide nomme les dix
 *       champs que la Forge accepte)
 * @spec docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-40 (l'aperçu du message, sous le gabarit)
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** État initial. `status: 'loading'` et non un état vide : « pas encore su »
 *  n'est pas « aucun canal » (§38.1.1 appliqué ici). */
export const ALERTES_VIDE = {
  status: 'loading', config: null, live: null, error: null,
  refus: null, enregistre: null, mot: '',
  // SPK-140 · §47.3.0 bis : ce qu'un refus a laissé dans le formulaire, ou
  // `null` — le formulaire montre alors la configuration relue.
  saisie: null,
  // SPK-151 · SPK-DS-40 : le dernier aperçu du message, ou `null`.
  apercu: null,
};

/**
 * L'aperçu du message, tel que la Forge le rend (SPK-151).
 *
 * @spec docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-40 · docs/DESIGN_SYSTEM.md §6.13, §14.6
 *
 * Un champ inconnu n'est pas un refus — rien n'a été tenté — : il se dit en
 * avertissement, avec ce que l'enregistrement en ferait.
 */
export function renderApercu(apercu) {
  if (!apercu) return '';
  if (apercu.status === 'loading') return '<p class="note">Calcul du message…</p>';
  if (apercu.status === 'error') {
    return `<p class="refus">${echapper(apercu.error)}</p>`;
  }
  if (apercu.unknown_fields?.length) {
    return `<p class="avertissement">Champ inconnu : ${apercu.unknown_fields
      .map((c) => `<code>${echapper(c)}</code>`).join(', ')}. Ce gabarit serait refusé à
      l’enregistrement.</p>`;
  }
  return `<p class="note">Sur un événement d’exemple — la levée d’une protection :</p>
    <pre class="fragment technique bloc-cle" tabindex="0">${echapper(apercu.rendered)}</pre>${
    apercu.valid_json === false
      ? `<p class="avertissement">Ce message n’est pas un document JSON : la plupart des
         services le refuseront.</p>` : ''}`;
}

/**
 * Les QUATRE états d'un canal, jamais confondus (§14.6).
 *
 * L'ordre des tests compte : « mal configuré » l'emporte sur « en échec »,
 * parce qu'un canal qui n'a rien tenté n'a rien raté — dire « en échec » y
 * enverrait chercher une panne de réseau là où il y a une faute de gabarit.
 */
export function etatDuCanal(config, live) {
  if (!config?.enabled) return config?.configured ? 'desactive' : 'absent';
  if (live?.misconfigured) return 'malconfigure';
  return (Number(live?.failed ?? 0) + Number(live?.dropped ?? 0)) > 0 ? 'echec' : 'actif';
}

const PHRASES = {
  absent: ['absence', '<strong>Aucun canal n’est configuré.</strong> Aucune alerte '
    + 'ne part lorsqu’un Spark est supprimé, qu’une protection est levée ou qu’un '
    + 'accès est donné. Ce n’est pas une panne — la Forge fonctionne — mais rien '
    + 'n’est surveillé.'],
  desactive: ['avertissement', '<strong>Le canal est configuré mais désactivé.</strong> '
    + 'Son adresse est conservée : la réactiver ne demande pas de la ressaisir. '
    + 'D’ici là, aucune alerte ne part.'],
  malconfigure: ['erreur', '<strong>Le canal est actif mais n’envoie rien.</strong> '
    + 'Son gabarit nomme un champ que l’alerte ne publie pas. Aucun envoi n’a été '
    + 'tenté — le défaut est vu <strong>avant</strong> l’incident, et non pendant.'],
  echec: ['avertissement', '<strong>Des alertes ne sont pas parties.</strong> Les '
    + 'gestes, eux, ont abouti : un canal muet n’empêche jamais d’agir.'],
  actif: ['succes', 'Le canal veille, et toutes les alertes sont parties.'],
};

function renderEtat(config, live) {
  const etat = etatDuCanal(config, live);
  const [classe, phrase] = PHRASES[etat];
  const champs = (live?.unknown_fields ?? []).map(echapper).join(', ');
  const motif = live?.last_error ? ` Dernier motif : ${echapper(live.last_error)}.` : '';
  return `<p class="${classe}" data-etat-canal="${etat}"${
    etat === 'malconfigure' ? ' role="alert"' : ''}>${phrase}${
    etat === 'malconfigure' && champs ? ` Champ refusé : <code>${champs}</code>.` : ''}${
    etat === 'echec' ? motif : ''}</p>`;
}

/**
 * D'où vient ce qui veille (§47.3.0 bis, point 1).
 *
 * Une Forge peut encore tourner sur `SPARKD_NOTIFY_URL`. Le taire ferait régler
 * cet écran sans effet et sans le savoir — c'est le pire des deux, parce que
 * l'écran dirait alors le contraire de ce qui se passe.
 */
function renderSource(live) {
  if (live?.source !== 'environnement') return '';
  return `<p class="avertissement" data-source="environnement"><strong>Ce qui veille
  en ce moment vient d’une variable d’environnement</strong>, pas de cet écran.
  Enregistrer ici posera la configuration au registre, qui l’emportera ensuite.</p>`;
}

/**
 * Ce qu'un refus garde de la saisie (SPK-140, §47.3.0 bis).
 *
 * @spec docs/BACKLOG.md#SPK-140 · docs/DAT.md §47.3.0 bis · docs/DESIGN_SYSTEM.md
 *       §6.11 (un refus n'efface pas la saisie), §7.1
 *
 * Le gabarit, l'adresse TAPÉE et la case. Le mot de passe n'y est pas : il se
 * redonne à chaque écriture (§47.3.3), et un secret ne se recopie pas dans la
 * page pour épargner une frappe.
 */
export function saisieAlertes(donnees) {
  return {
    url: String(donnees.get('webhook_url') ?? '').trim(),
    template: String(donnees.get('webhook_template') ?? ''),
    enabled: Boolean(donnees.get('webhook_enabled')),
  };
}

export function renderAlertes(etat = ALERTES_VIDE) {
  const entete = '<h1 id="titre-alertes">Alerte hors bande</h1>';
  if (etat.status === 'loading') {
    return `<section class="carte bloc" aria-labelledby="titre-alertes" aria-busy="true">
  ${entete}<p class="sr-only" role="status">Chargement…</p></section>`;
  }
  if (etat.status === 'error') {
    return `<section class="carte bloc" aria-labelledby="titre-alertes">
  ${entete}<p class="refus" role="alert">${echapper(etat.error)}</p></section>`;
  }

  const c = etat.config?.webhook ?? {};
  const live = etat.live ?? {};
  const garde = etat.config?.guard_set;
  // SPK-140 : après un refus, ce qui a été tapé l'emporte sur le registre.
  const saisie = etat.saisie;
  const gabarit = saisie ? saisie.template : (c.template ?? '');
  const veille = saisie ? saisie.enabled : Boolean(c.enabled);

  return `
<section class="carte bloc" aria-labelledby="titre-alertes">
  ${entete}
  <p class="note">Sur un geste destructif ou une levée de protection, la Forge
  poste un message vers un canal que vous choisissez. Elle ne prévient pas : elle
  <strong>détecte</strong>, et c’est ce qui sert encore quand tout le reste a
  échoué. <a href="#/manuel/M11">Manuel M11 — Sécurité et limites</a></p>
  ${renderSource(live)}
  ${renderEtat(c, live)}
  <div class="definitions">
    <div class="def"><dt>Envoyées</dt><dd>${echapper(String(live.sent ?? 0))}</dd></div>
    <div class="def"><dt>En échec</dt><dd>${echapper(String(live.failed ?? 0))}</dd></div>
    <div class="def"><dt>Abandonnées</dt><dd>${echapper(String(live.dropped ?? 0))}</dd></div>
  </div>
  <p class="note">Ces compteurs repartent de zéro à chaque redémarrage du serveur.</p>
</section>

<form class="carte bloc" id="formulaire-alertes" aria-labelledby="titre-webhook" novalidate>
  <h2 id="titre-webhook">Webhook</h2>
  ${c.configured ? `<p class="note">Canal posé sur <code>${echapper(c.host)}</code>.
  <strong>Son adresse ne s’affiche pas</strong>, ici ni ailleurs : qui la détient
  peut écrire à votre place. Laissez le champ vide pour la conserver.</p>` : ''}

  <div class="champ">
    <label for="alerte-url">Adresse du webhook</label>
    <input type="url" id="alerte-url" name="webhook_url" class="controle"
           placeholder="${c.configured ? 'inchangée' : 'https://…'}"${
             saisie?.url ? ` value="${echapper(saisie.url)}"` : ''}
           aria-describedby="alerte-url-aide">
    <p class="champ__aide" id="alerte-url-aide">Slack, Discord, <code>ntfy</code>,
    ou votre propre service derrière un port.</p>
  </div>

  <div class="champ">
    <label for="alerte-gabarit">Gabarit du message</label>
    <textarea id="alerte-gabarit" name="webhook_template" class="controle" rows="3"
              aria-describedby="alerte-gabarit-aide">${echapper(gabarit)}</textarea>
    <p class="champ__aide" id="alerte-gabarit-aide">La plupart des services
    veulent le message à leur forme — Discord attend <code>{"content": …}</code>,
    Slack <code>{"text": …}</code>. Remplacez <code>{champ}</code> par la valeur
    de l’alerte. Champs disponibles : <code>version</code>, <code>ts</code>,
    <code>forge</code>, <code>action</code>, <code>actor</code>,
    <code>actor_class</code>, <code>target_type</code>, <code>target_id</code>,
    <code>result</code>, <code>message</code>.
    <strong>Un champ inconnu est refusé ici</strong>, et non le jour de
    l’incident. Vide, le message part en JSON structuré.</p>
    <p class="formulaire__actions"><button type="button" class="bouton" data-alertes-apercu>Voir le message</button></p>
    <div id="alerte-apercu" role="status">${renderApercu(etat.apercu)}</div>
  </div>

  <div class="champ">
    <label for="alerte-actif">
      <input type="checkbox" id="alerte-actif" name="webhook_enabled"
             ${veille ? 'checked' : ''}> Le canal veille
    </label>
    <p class="champ__aide">Le décocher <strong>conserve l’adresse</strong>. Une
    dernière alerte part alors par ce canal, pendant qu’il fonctionne encore :
    couper le témoin ne doit pas être le seul geste dont personne n’entend parler.</p>
  </div>

  <div class="champ">
    <label for="alerte-mot">Mot de passe des canaux</label>
    <input type="password" id="alerte-mot" name="password" class="controle"
           autocomplete="off" aria-describedby="alerte-mot-aide">
    <p class="champ__aide" id="alerte-mot-aide">${garde
      ? 'Exigé à chaque modification — il n’y a pas de session déverrouillée.'
      : '<strong>Aucun mot de passe n’est encore fixé.</strong> Celui que vous '
        + 'donnez ici deviendra le mot de passe, et sera exigé ensuite.'}</p>
  </div>

  ${etat.refus ? `<p class="refus" role="alert">${echapper(etat.refus)}</p>` : ''}
  ${etat.enregistre ? `<p class="succes" role="status">${echapper(etat.enregistre)}</p>` : ''}

  <p class="formulaire__actions">
    <button type="submit" class="bouton bouton--primaire">Enregistrer</button>
  </p>
</form>`;
}
