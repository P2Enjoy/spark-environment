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
 * @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 (le canal SMTP : mode TLS,
 *       certificat toujours vérifié, mot de passe scellé qui ne s'affiche jamais),
 *       §47.3.2 bis (deux témoins indépendants : chacun son état et ses
 *       compteurs), §47.3.2 ter (couper un canal le dit) · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-52 · docs/DESIGN_SYSTEM.md §6.11, §6.13, §14.6
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
  // SPK-62 · §47.3.2 : l'état VIVANT du canal courriel, et son formulaire — qui a SON refus,
  // SA saisie retenue, SON message de succès : deux témoins, deux formulaires, rien de partagé.
  liveSmtp: null,
  smtp: { refus: null, enregistre: null, saisie: null },
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

/** SPK-62 · §47.3.2 : les mêmes états, dits pour le canal courriel. */
const PHRASES_SMTP = {
  desactive: ['avertissement', '<strong>Le canal courriel est configuré mais désactivé.</strong> '
    + 'Le serveur, les adresses et le mot de passe sont conservés : le réactiver ne demande '
    + 'pas de les ressaisir. D’ici là, aucun courriel ne part.'],
  malconfigure: ['erreur', '<strong>Le canal courriel est actif mais n’envoie rien.</strong> '
    + 'Le mot de passe enregistré ne se déchiffre pas : ressaisissez-le. Aucun envoi n’a été '
    + 'tenté — le défaut est vu <strong>avant</strong> l’incident, et non pendant.'],
  echec: ['avertissement', '<strong>Des courriels ne sont pas partis.</strong> Les '
    + 'gestes, eux, ont abouti : un canal muet n’empêche jamais d’agir.'],
  actif: ['succes', 'Le canal courriel veille, et toutes les alertes sont parties.'],
};

function renderEtat(config, live, phrases = PHRASES, canal = 'webhook') {
  const etat = etatDuCanal(config, live);
  if (etat === 'absent' && canal !== 'webhook') return '';
  const [classe, phrase] = phrases[etat] ?? PHRASES[etat];
  const champs = (live?.unknown_fields ?? []).map(echapper).join(', ');
  const motif = live?.last_error ? ` Dernier motif : ${echapper(live.last_error)}.` : '';
  return `<p class="${classe}" data-etat-canal="${etat}" data-canal="${canal}"${
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

/**
 * Ce qu'un refus garde du formulaire COURRIEL (SPK-140 étendu, §47.3.0 bis).
 *
 * Le serveur, le port, le mode, le compte, les adresses et la case. Ni le mot de passe du garde,
 * ni le mot de passe du compte : un secret ne se recopie pas dans la page pour épargner une frappe.
 */
export function saisieSmtp(donnees) {
  const lire = (nom) => String(donnees.get(nom) ?? '').trim();
  return {
    host: lire('smtp_host'), port: lire('smtp_port'), tls: lire('smtp_tls') || 'starttls',
    username: lire('smtp_username'), from: lire('smtp_from'), to: lire('smtp_to'),
    enabled: Boolean(donnees.get('smtp_enabled')),
  };
}

const MODES_TLS = [
  ['starttls', 'STARTTLS — port 587 d’ordinaire (recommandé)'],
  ['tls', 'TLS implicite — port 465 d’ordinaire'],
  ['none', 'Aucun — un relais interne, sans compte'],
];

function renderCompteurs(live) {
  return `<div class="definitions">
    <div class="def"><dt>Envoyées</dt><dd>${echapper(String(live?.sent ?? 0))}</dd></div>
    <div class="def"><dt>En échec</dt><dd>${echapper(String(live?.failed ?? 0))}</dd></div>
    <div class="def"><dt>Abandonnées</dt><dd>${echapper(String(live?.dropped ?? 0))}</dd></div>
  </div>`;
}

/**
 * La carte du canal COURRIEL : son état, ses compteurs, son formulaire (SPK-62 · §47.3.2).
 *
 * @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2, §47.3.3 · docs/DESIGN_SYSTEM_APP.md SPK-DS-52
 *
 * **Le mot de passe du compte ne s'affiche jamais** : on dit seulement qu'il est enregistré, et le
 * laisser vide le CONSERVE. Le certificat du serveur est toujours vérifié, et l'écran le dit : il n'y
 * a pas d'interrupteur pour s'en dispenser. Comme pour le webhook, aucun bouton n'envoie de message
 * d'épreuve — la seule épreuve d'un canal est un vrai geste sensible (§47.3.0 bis).
 */
function renderSmtp(etat, garde) {
  const c = etat.config?.smtp ?? {};
  const live = etat.liveSmtp ?? {};
  const f = etat.smtp ?? {};
  const saisie = f.saisie;
  const v = saisie ?? { host: c.host ?? '', port: c.port ?? '', tls: c.tls || 'starttls',
                        username: c.username ?? '', from: c.from ?? '', to: c.to ?? '',
                        enabled: Boolean(c.enabled) };
  const etatCanal = renderEtat(c, live, PHRASES_SMTP, 'smtp');
  return `
<form class="carte bloc" id="formulaire-smtp" aria-labelledby="titre-smtp" novalidate>
  <h2 id="titre-smtp">Courriel (SMTP)</h2>
  ${etatCanal || '<p class="note">Ce canal n’est pas configuré.</p>'}
  ${renderCompteurs(live)}

  <div class="champ">
    <label for="smtp-hote">Serveur</label>
    <input type="text" id="smtp-hote" name="smtp_host" class="controle" autocomplete="off"
           spellcheck="false" value="${echapper(v.host)}" placeholder="smtp.exemple.fr">
  </div>
  <div class="champ">
    <label for="smtp-port">Port</label>
    <input type="number" id="smtp-port" name="smtp_port" class="controle" min="1" max="65535"
           value="${echapper(v.port)}" placeholder="587">
  </div>
  <div class="champ">
    <label for="smtp-tls">Chiffrement</label>
    <select id="smtp-tls" name="smtp_tls" class="controle" aria-describedby="smtp-tls-aide">
      ${MODES_TLS.map(([valeur, libelle]) =>
        `<option value="${valeur}"${v.tls === valeur ? ' selected' : ''}>${echapper(libelle)}</option>`).join('')}
    </select>
    <p class="champ__aide" id="smtp-tls-aide">Le certificat du serveur est
    <strong>toujours vérifié</strong> : il n’existe aucun réglage pour s’en dispenser.
    Un mot de passe ne part jamais en clair — un compte exige STARTTLS ou TLS.</p>
  </div>
  <div class="champ">
    <label for="smtp-compte">Compte</label>
    <input type="text" id="smtp-compte" name="smtp_username" class="controle" autocomplete="off"
           spellcheck="false" value="${echapper(v.username)}" aria-describedby="smtp-compte-aide">
    <p class="champ__aide" id="smtp-compte-aide">Laissez vide pour un relais sans
    authentification. Vider le compte efface aussi le mot de passe enregistré.</p>
  </div>
  <div class="champ">
    <label for="smtp-secret">Mot de passe du compte</label>
    <input type="password" id="smtp-secret" name="smtp_password" class="controle"
           autocomplete="new-password" placeholder="${c.password_set ? 'inchangé' : ''}"
           aria-describedby="smtp-secret-aide">
    <p class="champ__aide" id="smtp-secret-aide">${c.password_set
      ? '<strong>Un mot de passe est enregistré</strong> ; il ne s’affiche pas, ici ni ailleurs. '
        + 'Laissez le champ vide pour le conserver.'
      : 'Aucun mot de passe n’est enregistré. Il est chiffré avec la clé de la Forge.'}</p>
  </div>
  <div class="champ">
    <label for="smtp-de">Adresse d’envoi</label>
    <input type="email" id="smtp-de" name="smtp_from" class="controle" autocomplete="off"
           value="${echapper(v.from)}" placeholder="forge@exemple.fr">
  </div>
  <div class="champ">
    <label for="smtp-a">Destinataire(s)</label>
    <input type="text" id="smtp-a" name="smtp_to" class="controle" autocomplete="off"
           spellcheck="false" value="${echapper(v.to)}" placeholder="admin@exemple.fr"
           aria-describedby="smtp-a-aide">
    <p class="champ__aide" id="smtp-a-aide">Une à dix adresses, séparées par des virgules.
    Le message porte les dix champs de l’alerte, en texte — jamais le détail du geste.</p>
  </div>

  <div class="champ">
    <label for="smtp-actif">
      <input type="checkbox" id="smtp-actif" name="smtp_enabled" ${v.enabled ? 'checked' : ''}> Le canal veille
    </label>
    <p class="champ__aide">Le décocher <strong>conserve la configuration</strong>. Un dernier
    message part alors par ce canal, et par l’autre s’il veille, pendant qu’ils fonctionnent encore.</p>
  </div>

  <div class="champ">
    <label for="smtp-mot">Mot de passe des canaux</label>
    <input type="password" id="smtp-mot" name="password" class="controle"
           autocomplete="off" aria-describedby="smtp-mot-aide">
    <p class="champ__aide" id="smtp-mot-aide">${garde
      ? 'Le même que pour le webhook, exigé à chaque modification.'
      : '<strong>Aucun mot de passe n’est encore fixé.</strong> Celui que vous donnez ici '
        + 'deviendra le mot de passe des canaux, et sera exigé ensuite.'}</p>
  </div>

  ${f.refus ? `<p class="refus" role="alert">${echapper(f.refus)}</p>` : ''}
  ${f.enregistre ? `<p class="succes" role="status">${echapper(f.enregistre)}</p>` : ''}

  <p class="formulaire__actions">
    <button type="submit" class="bouton bouton--primaire">Enregistrer le canal courriel</button>
  </p>
</form>`;
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
  // SPK-62 : « aucun canal » ne se dit que si AUCUN des deux ne veille ni n'est posé.
  const aucunCanal = etatDuCanal(c, live) === 'absent'
    && etatDuCanal(etat.config?.smtp, etat.liveSmtp) === 'absent';
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
  <p class="note">Deux canaux, <strong>indépendants</strong> : le webhook et le courriel
  s’activent et se coupent séparément, et l’échec de l’un n’empêche pas l’autre de partir.</p>
  ${renderSource(live)}
  ${aucunCanal ? renderEtat(c, live) : ''}
  <p class="note">Les compteurs de chaque canal repartent de zéro à chaque redémarrage du serveur.</p>
</section>

<form class="carte bloc" id="formulaire-alertes" aria-labelledby="titre-webhook" novalidate>
  <h2 id="titre-webhook">Webhook</h2>
  ${aucunCanal ? '' : (etatDuCanal(c, live) === 'absent'
    ? '<p class="note">Ce canal n’est pas configuré.</p>' : renderEtat(c, live))}
  ${renderCompteurs(live)}
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
</form>
${renderSmtp(etat, garde)}`;
}
