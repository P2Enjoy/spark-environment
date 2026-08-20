/**
 * Recettes DNS : un jeu d'enregistrements posé ENSEMBLE.
 *
 * @spec docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.6 (les recettes),
 *       §38.6.1 (une recette est une fonction, pas une donnée stockée),
 *       §38.6.2 (la garde élargie), §38.6.3 (le compte rendu),
 *       §38.6.4 (les deux premières recettes), §38.7 (ce que le DNS ne peut
 *       pas faire) · §38.2 (le produit ne supprime rien qu'il n'a pas posé)
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
export const RECETTES = {
  'site-web': {
    id: 'site-web',
    label: 'Site web sur le domaine nu',
    description: "Fait répondre le domaine lui-même et son « www » sur cette Forge. "
      + "Deux enregistrements, aucune valeur extérieure.",
    parametres: [
      { nom: 'domain', label: 'Domaine', aide: 'Le domaine nu, par exemple « exemple.tech ».' },
      { nom: 'address', label: 'Adresse publique de la Forge',
        aide: "C'est l'adresse de la FORGE, pas celle du Spark." },
    ],
    actionsHumaines: [],
    composer({ domain, address }) {
      const nu = normaliser(domain);
      if (!nu) throw new DnsError('Aucun domaine fourni.');
      return [
        { domain: nu, type: 'A', data: address,
          role: 'Le domaine lui-même répond sur cette Forge.' },
        { domain: `www.${nu}`, type: 'A', data: address,
          role: 'Le « www » y répond aussi.' },
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
      { nom: 'domain', label: 'Sous-domaine émetteur',
        aide: 'Par exemple « noreply.exemple.tech ». Il n’aura pas de boîte aux lettres.' },
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
    composer({ domain, selector, dkim, policy }) {
      const emetteur = normaliser(domain);
      if (!emetteur) throw new DnsError('Aucun sous-domaine fourni.');
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
export function catalogue() {
  return Object.values(RECETTES).map((r) => ({
    id: r.id, label: r.label, description: r.description,
    parametres: r.parametres, actionsHumaines: r.actionsHumaines,
  }));
}


/**
 * Compose la recette et PRÉPARE chaque enregistrement (§38.6.1, §38.6.2).
 *
 * Chaque ligne passe la garde du §38.5 : une recette n'est pas une porte
 * dérobée qui écrirait ce qu'une écriture simple refuserait.
 */
export function composer(id, params = {}, { zone, ttl, motif = null } = {}) {
  const recette = RECETTES[id];
  if (!recette) throw new DnsError(`Recette « ${id} » inconnue.`);
  if (!zone) throw new DnsError('Aucune zone choisie.');

  const lignes = recette.composer(params);
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
    actionsHumaines: recette.actionsHumaines ?? [],
    incomplete: recette.incomplete ? recette.incomplete(params) : null,
  };
}
