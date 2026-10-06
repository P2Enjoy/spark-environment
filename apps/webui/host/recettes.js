/**
 * Recettes DNS : un jeu d'enregistrements posé ENSEMBLE.
 *
 * @spec docs/BACKLOG.md#SPK-88 · docs/DAT.md §38.6.4 bis (une recette pose
 *       AUSSI sa route ; la route AVANT le DNS ; une route déjà là vers le même
 *       Spark n'est pas un refus) · §26.3 (le port ne se devine pas)
 * @spec docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.6 (les recettes),
 *       §38.6.1 (une recette est une fonction, pas une donnée stockée),
 *       §38.6.2 (la garde élargie), §38.6.3 (le compte rendu),
 *       §38.6.4 (les deux premières recettes), §38.7 (ce que le DNS ne peut
 *       pas faire) · §38.2 (le produit ne supprime rien qu'il n'a pas posé)
 * @spec docs/BACKLOG.md#SPK-149 · docs/DAT.md §38.6.6 (le nom se saisit dans la
 *       zone, plusieurs niveaux, chaque niveau validé ; l'adresse pré-remplie)
 *
 * Une recette à moitié posée est pire qu'une recette absente : un `MX` sans SPF
 * fait recevoir du courrier qu'on ne peut pas renvoyer. D'où le compte rendu
 * ligne à ligne, et le refus d'annoncer un succès global.
 *
 * Rien n'est stocké ici : une recette enregistrée divergerait du code dès la
 * première correction, et deux vérités coexisteraient sans qu'on sache laquelle
 * est appliquée (§38.6.1).
 */

import { DnsError, preparerEnregistrement, normaliser } from './dns.js';

/** Une valeur que l'exploitant doit fournir, et qu'on n'invente jamais. */
export class ValeurManquante extends Error {
  constructor(champ, message) {
    super(message);
    this.champ = champ;
  }
}

/**
 * Le catalogue. Chaque entrée décrit ce qu'elle réclame, ce qu'elle pose, et ce
 * qu'elle NE PEUT PAS faire — le §38.7 veut que ces trois choses soient dites
 * ensemble, pas seulement la deuxième.
 */
/** Un niveau de nom d'hôte : lettres, chiffres, tirets, ni en tête ni en fin. */
const NIVEAU = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Nom complet d'un paramètre déclaré `dansLaZone` (§38.6.6).
 *
 * La zone est déjà choisie : le champ ne porte que le libellé, et vide vaut
 * l'apex. Un libellé qui porte DÉJÀ le suffixe de la zone est accepté tel quel —
 * c'est une saisie par habitude, elle ne peut vouloir dire qu'une chose, et la
 * refuser ferait perdre une saisie juste pour une raison de forme.
 *
 * SPK-149 : un libellé peut avoir PLUSIEURS niveaux — `mcp.api` compose
 * `mcp.api.<zone>`. Il était refusé comme ambigu ; mais la zone s'affiche en
 * suffixe du champ, et l'aperçu montre le nom complet avant d'écrire. Accepter
 * les points oblige en revanche à refuser ce qu'ils permettent de mal écrire :
 * chaque niveau est validé ici, avant tout appel, plutôt que refusé après coup
 * par le fournisseur ou par `sparkd` (§38.6.2).
 */
export function dansLaZone(libelle, zone) {
  const nu = normaliser(zone);
  if (!nu) return '';
  const brut = normaliser(libelle);
  if (!brut || brut === nu) return nu;
  const relatif = brut.endsWith(`.${nu}`) ? brut.slice(0, -(nu.length + 1)) : brut;
  if (!relatif.split('.').every((niveau) => NIVEAU.test(niveau))) {
    throw new DnsError(
      `« ${brut} » n'est pas un sous-domaine valide : chaque niveau, séparé par un `
      + `point, porte de 1 à 63 lettres, chiffres ou tirets, sans tiret en tête ni `
      + `en fin.`);
  }
  return `${relatif}.${nu}`;
}

export const RECETTES = {
  'site-web': {
    id: 'site-web',
    label: 'Site web sur le domaine nu',
    description: "Fait répondre le domaine lui-même et son « www » sur cette Forge. "
      + "Deux enregistrements, aucune valeur extérieure.",
    parametres: [
      // §38.6.6 : la ZONE est déjà choisie. Redemander le domaine entier faisait
      // ressaisir ce que l'écran sait, et l'aide invitait à taper un nom d'une
      // AUTRE zone — que le serveur refuse aussitôt. Le champ ne porte donc plus
      // que le libellé, et vide vaut le domaine lui-même.
      { nom: 'domain', label: 'Sous-domaine', dansLaZone: true, facultatif: true,
        // Espaces insécables dans les guillemets : vu en capture, « et le nom se
        // séparaient en fin de ligne.
        aide: 'Laisser vide pour le domaine lui-même. Un point sépare plusieurs '
          + 'niveaux\u00a0: «\u00a0mcp.api\u00a0».' },
      // §38.6.6 : la console SAIT à quelle Forge elle est reliée. Redemander son
      // adresse à chaque recette, c'est faire ressaisir ce que l'inventaire
      // porte déjà — et une recette existe pour simplifier, pas pour interroger.
      { nom: 'address', label: 'Adresse publique de la Forge', adresseForge: true,
        aide: "C'est l'adresse de la FORGE, pas celle du Spark." },
      // SPK-88 · §38.6.4 bis : sans route, la Forge répond une erreur pour ce
      // nom — la recette livrait la moitié du résultat. Le port ne se devine
      // d'aucun enregistrement DNS (§26.3).
      { nom: 'port', label: 'Port du Spark', defaut: '8080', port: true,
        aide: "Le port sur lequel écoute la pile DANS le Spark, pas celui de la "
          + "Forge. Aucun enregistrement DNS ne le dit." },
    ],
    actionsHumaines: [],
    composer({ domain, address }, zone) {
      const nu = dansLaZone(domain, zone);
      if (!nu) throw new DnsError('Aucune zone choisie.');
      return [
        // SPK-149 : le rôle dit ce que la ligne vise. « Le domaine lui-même »
        // à côté d'un sous-domaine faisait croire que la racine était visée.
        { domain: nu, type: 'A', data: address,
          role: nu === normaliser(zone)
            ? 'Le domaine lui-même répond sur cette Forge.'
            : 'Ce sous-domaine répond sur cette Forge.' },
        { domain: `www.${nu}`, type: 'A', data: address,
          role: 'Le « www » y répond aussi.' },
      ];
    },
    /**
     * Les routes qui rendent ces enregistrements utiles (§38.6.4 bis).
     *
     * Les deux noms écrits pointent vers la Forge ; sans route, elle ne les sert
     * pas. Ce sont donc les mêmes deux noms, et pas un de plus : une recette ne
     * déclare que ce qu'elle a écrit.
     */
    routes({ domain, port }, zone) {
      const nu = dansLaZone(domain, zone);
      if (!nu) throw new DnsError('Aucune zone choisie.');
      const cible = Number(port);
      if (!Number.isInteger(cible) || cible < 1 || cible > 65535) {
        throw new DnsError(`Port « ${port} » hors bornes : 1 à 65535.`);
      }
      return [
        { domain: nu, port: cible, tls: true,
          role: nu === normaliser(zone)
            ? 'Le domaine nu est servi par ce Spark.'
            : 'Ce sous-domaine est servi par ce Spark.' },
        { domain: `www.${nu}`, port: cible, tls: true,
          role: 'Le « www » aussi.' },
      ];
    },
  },

  'relais-transactionnel': {
    id: 'relais-transactionnel',
    label: 'Émission par le relais transactionnel',
    description: "Fait émettre un sous-domaine par le relais du fournisseur. "
      + "ATTENTION : ce sous-domaine ÉMET et NE REÇOIT PAS — son « MX » pointe "
      + "vers un puits. Ne l'appliquez pas sur un domaine censé recevoir du courrier.",
    parametres: [
      { nom: 'domain', label: 'Sous-domaine émetteur', dansLaZone: true,
        aide: 'Par exemple « noreply ». Il n’aura pas de boîte aux lettres.' },
      { nom: 'selector', label: 'Sélecteur DKIM',
        aide: "L'identifiant de projet du fournisseur, tel qu'il apparaît dans sa console." },
      { nom: 'dkim', label: 'Clé publique DKIM', facultatif: true,
        aide: "À LIRE dans la console du fournisseur, à la vérification du domaine. "
          + "Laissée vide, la recette est posée mais INCOMPLÈTE : les messages "
          + "partiront sans signature." },
      { nom: 'policy', label: 'Politique DMARC', defaut: 'none',
        aide: '« none » observe, « quarantine » met de côté, « reject » refuse.' },
    ],
    actionsHumaines: [
      "Vérifier le domaine dans la console du fournisseur : c'est elle qui produit "
      + 'la clé DKIM que cette recette réclame.',
      'Le DNS inverse (PTR) ne vit pas dans la zone : il se déclare sur l’adresse IP, '
      + 'chez l’hébergeur.',
    ],
    composer({ domain, selector, dkim, policy }, zone) {
      // Le champ ne porte que le libellé : la zone est déjà choisie (§38.6.6).
      // Ici, à la différence du site web, l'apex n'a pas de sens — un domaine qui
      // ÉMET sans recevoir ne doit pas être le domaine principal.
      if (!normaliser(domain)) throw new DnsError('Aucun sous-domaine fourni.');
      const emetteur = dansLaZone(domain, zone);
      if (!emetteur) throw new DnsError('Aucune zone choisie.');
      const choisie = String(policy || 'none').trim();
      if (!['none', 'quarantine', 'reject'].includes(choisie)) {
        throw new DnsError(
          `Politique DMARC « ${choisie} » inconnue : none, quarantine ou reject.`);
      }
      const selecteur = String(selector ?? '').trim();
      if (!selecteur) {
        throw new ValeurManquante('selector',
          "Le sélecteur DKIM est l'identifiant de projet du fournisseur. Sans lui, "
          + "l'enregistrement de signature ne peut pas être nommé.");
      }
      const lignes = [
        { domain: emetteur, type: 'MX', data: '0 blackhole.tem.scaleway.com.',
          role: 'Ce sous-domaine ÉMET et ne reçoit pas : son courrier entrant tombe dans un puits.' },
        { domain: emetteur, type: 'TXT', data: '"v=spf1 include:_spf.tem.scaleway.com -all"',
          role: 'Seul le relais du fournisseur a le droit d’émettre pour ce nom.' },
        { domain: `_dmarc.${emetteur}`, type: 'TXT', data: `"v=DMARC1; p=${choisie}"`,
          role: 'Ce qu’il faut faire d’un message qui échoue aux deux contrôles.' },
      ];
      const cle = String(dkim ?? '').trim();
      if (cle) {
        lignes.push({
          domain: `${selecteur}._domainkey.${emetteur}`, type: 'TXT',
          data: cle.startsWith('"') ? cle : `"${cle}"`,
          role: 'La clé publique qui vérifie la signature des messages.',
        });
      }
      return lignes;
    },
    /** Ce qui manque quand la recette est posée sans sa clé (§38.6.4). */
    incomplete({ dkim }) {
      return String(dkim ?? '').trim()
        ? null
        : "La clé DKIM n'a pas été fournie : la recette est posée, mais les "
          + "messages partiront SANS SIGNATURE et seront traités avec méfiance. "
          + "Lisez la clé dans la console du fournisseur, puis réappliquez.";
    },
  },
};


/** Le catalogue, sous une forme que l'écran peut afficher sans le connaître. */
export function catalogue({ adresseForge = null } = {}) {
  return Object.values(RECETTES).map((r) => ({
    id: r.id, label: r.label, description: r.description,
    // La valeur par défaut est POSÉE ICI, au moment où le catalogue est servi :
    // elle dépend du serveur courant, pas de la recette. L'écrire dans la
    // définition en ferait une constante, et elle mentirait au changement de
    // Forge (§38.6.6).
    parametres: r.parametres.map((p) => (p.adresseForge && adresseForge
      ? { ...p, defaut: adresseForge,
          aide: `${p.aide} Pré-rempli depuis le serveur courant.` }
      : p)),
    actionsHumaines: r.actionsHumaines,
    // L'écran doit pouvoir DIRE, avant de choisir, qu'une recette déclarera des
    // routes : ce n'est pas le même geste qu'une écriture DNS seule.
    poseDesRoutes: Boolean(r.routes),
  }));
}

/**
 * Adresse publique d'une entrée d'inventaire, ou `null` si elle ne peut pas être
 * connue.
 *
 * Une Forge locale n'en a pas ; une entrée déclarée par ALIAS `ssh` cache la
 * sienne dans `~/.ssh/config`, que le produit ne lit pas pour cela. Dans ces
 * deux cas on rend `null` et le champ reste vide : proposer une valeur fausse
 * serait pire que ne rien proposer (docs/DESIGN_SYSTEM.md §14.6).
 */
export function adressePublique(serveur) {
  if (!serveur) return null;
  // SPK-77 · §38.8.5 : ce qui est DÉCLARÉ prime sur ce qui est déduit. Le
  // transport ne porte pas toujours l'adresse publique — un alias `ssh` la cache
  // dans le `ssh_config`, et une Forge locale est atteinte par une boucle
  // locale alors que la machine, elle, peut très bien avoir une adresse
  // publique. C'est ce qui lève la limite connue du §38.6.6.
  const declaree = String(serveur.publicAddress ?? '').trim();
  if (declaree) return declaree;
  if (serveur.kind === 'local') return null;
  const hote = String(serveur.host ?? '').trim();
  if (!hote || hote === '127.0.0.1' || hote === 'localhost') return null;
  return hote;
}


/**
 * Compose la recette et PRÉPARE chaque enregistrement (§38.6.1, §38.6.2).
 *
 * Chaque ligne passe la garde du §38.5 : une recette n'est pas une porte
 * dérobée qui écrirait ce qu'une écriture simple refuserait.
 */
export function composer(id, params = {}, { zone, ttl, motif = null,
                                            adresseForge = null } = {}) {
  const recette = RECETTES[id];
  if (!recette) throw new DnsError(`Recette « ${id} » inconnue.`);
  if (!zone) throw new DnsError('Aucune zone choisie.');

  // Les valeurs par défaut sont appliquées ICI, du même côté que celui qui les
  // propose. Les poser à l'affichage seulement ferait diverger ce que l'écran
  // MONTRE de ce que la requête PORTE — le champ afficherait l'adresse de la
  // Forge, et l'aperçu se plaindrait qu'elle manque. Mesuré (§38.6.6).
  const complets = { ...params };
  for (const p of recette.parametres) {
    if (complets[p.nom] !== undefined && String(complets[p.nom]).trim() !== '') continue;
    const defaut = p.adresseForge ? adresseForge : p.defaut;
    if (defaut) complets[p.nom] = defaut;
  }

  const lignes = recette.composer(complets, zone);
  return {
    recipe: recette.id,
    label: recette.label,
    records: lignes.map((ligne) => ({
      ...preparerEnregistrement({
        domain: ligne.domain, zone, type: ligne.type, data: ligne.data,
        ...(ttl == null ? {} : { ttl }), motif,
      }),
      role: ligne.role,
    })),
    // §38.6.4 bis : toutes les recettes n'en posent pas. `relais-transactionnel`
    // ne sert aucun trafic HTTP, et lui en inventer une serait inventer un
    // besoin. C'est une propriété de la recette, pas une option de l'écran.
    routes: recette.routes ? recette.routes(complets, zone) : [],
    actionsHumaines: recette.actionsHumaines ?? [],
    incomplete: recette.incomplete ? recette.incomplete(params) : null,
  };
}
