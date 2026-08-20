/**
 * Sessions de terminal vers un Spark, portées par l'hôte console.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.1 (la frontière tient : c'est
 *       la CONSOLE qui parle au Spark, pas `sparkd`), §37.2 (le chemin normal :
 *       SSH, et ce qu'il suppose), §37.4 (le contrat du terminal),
 *       §37.4.1 (le transport), §37.4.2 (ce qui crée et ce qui tue une session),
 *       §37.4.3 (la limite du redimensionnement), §37.4.5 (ce que le journal
 *       reçoit) · §37.5 (l'ouverture et la fermeture, RIEN du contenu) ·
 *       §37.3 (le dépannage par `incus exec`, borné et nommé)
 *
 * `sparkd` n'est pas dans ce chemin. La console fait ce que le responsable
 * ferait avec un terminal et sa clé : elle lui épargne les gestes, pas les
 * droits.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Délai d'inactivité avant fermeture (§37.4.2). Averti AVANT, jamais après. */
export const INACTIVITE_MS = 15 * 60 * 1000;

/** Combien de temps avant la fermeture l'avertissement est affiché. */
export const PREAVIS_MS = 60 * 1000;

/** Motifs de fermeture. Ils entrent au journal ; le contenu, jamais (§37.5). */
export const SORTIE = 'sortie';
export const INACTIVITE = 'inactivite';
export const FLUX_FERME = 'flux_ferme';
export const DISTANT_TERMINE = 'distant_termine';

export class TerminalError extends Error {}

/**
 * Les deux chemins d'entrée, et il n'y en a pas d'autre (§37.2, §37.3).
 *
 * `ssh` est le chemin NORMAL : la console se connecte au Spark avec la clé du
 * responsable, exactement comme il le ferait à la main. `rescue` est le chemin
 * de DÉPANNAGE : la console se connecte à la Forge et lui fait exécuter
 * `incus exec` dans la cellule. Le second donne au plan de contrôle l'exécution
 * arbitraire en root chez le locataire, ce que le §11 évite partout ailleurs.
 */
export const CHEMIN_SSH = 'ssh';
export const CHEMIN_DEPANNAGE = 'rescue';

/** Motifs qui OUVRENT le dépannage, et qui entrent au journal (§37.3). */
export const EN_ERREUR = 'spark_en_erreur';
export const SSHD_MUET = 'sshd_muet';

/**
 * Classe l'échec d'une connexion SSH vers un Spark.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.3 (« son `sshd` ne répond
 *       pas »), §22.3 (une panne se signale, avec son motif)
 *
 * Le point qui décide : « le `sshd` ne répond pas » et « le `sshd` répond et
 * refuse la clé » ne sont PAS le même incident, et n'appellent pas le même
 * geste. Le premier ouvre le dépannage — rien n'écoute, aucun accès normal
 * n'existe. Le second est un problème de clé : la réponse est de réaccorder
 * l'accès (§17), pas d'employer un pouvoir d'exception. Confondre les deux
 * ferait du dépannage la façon ordinaire d'entrer, ce que le §37.3 refuse.
 */
export function classerEchecSsh(code, stderr = '') {
  if (code === 0) return { repond: true, motif: null };
  const texte = String(stderr);
  if (/Connection refused|Connection timed out|No route to host|Network is unreachable|Operation timed out/i
      .test(texte)) {
    return { repond: false, motif: SSHD_MUET };
  }
  if (/Permission denied|Too many authentication failures|publickey/i.test(texte)) {
    return { repond: true, motif: 'cle_refusee' };
  }
  // Inconnu : on ne DÉCLARE pas le `sshd` muet sur une erreur qu'on ne
  // reconnaît pas. Ouvrir le dépannage sur un doute reviendrait à l'ouvrir
  // toujours, puisque toute panne finit par produire un message inconnu.
  return { repond: true, motif: 'inconnu' };
}

/**
 * Le dépannage est-il ouvert sur ce Spark ? Première condition du §37.3.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.3
 *
 * Fonction PURE, et c'est délibéré : cette règle est un contrôle d'accès au
 * sens du `CLAUDE.md` §10. Elle doit donc être appliquée par l'hôte console —
 * qui est le backend de ce chemin, `sparkd` n'y étant pas (§37.1) — et non par
 * l'écran. Masquer un bouton ne serait qu'une aide d'interface.
 *
 * `sondage` est le résultat de `classerEchecSsh`, ou `null` quand aucun sondage
 * n'a été fait. Sans cellule, il n'y a rien où exécuter : le refus le dit
 * plutôt que de laisser `incus exec` échouer sur un nom qui n'existe pas
 * (§37.2, même signal qu'au §39.4).
 */
export function depannageOuvert(spark, sondage = null) {
  if (!spark?.incus_name) {
    return { ouvert: false, motif: 'sans_cellule',
             explication: "Ce Spark n'a pas encore de cellule : il n'y a rien où "
               + "exécuter. Il doit d'abord être appliqué." };
  }
  if (spark.state === 'error') {
    return { ouvert: true, motif: EN_ERREUR,
             explication: 'Ce Spark est en erreur : le chemin normal ne peut pas '
               + 'être supposé disponible.' };
  }
  if (sondage && sondage.repond === false) {
    return { ouvert: true, motif: SSHD_MUET,
             explication: "Rien ne répond sur le port 22 de ce Spark : son « sshd » "
               + "est absent ou arrêté." };
  }
  if (sondage && sondage.motif === 'cle_refusee') {
    return { ouvert: false, motif: 'cle_refusee',
             explication: 'Le « sshd » de ce Spark répond mais refuse la clé. '
               + "C'est un problème d'accès, pas de dépannage : réaccordez la clé "
               + "depuis l'onglet Clés." };
  }
  return { ouvert: false, motif: 'ssh_disponible',
           explication: 'Le chemin normal est disponible : le dépannage est réservé '
             + 'au Spark en erreur ou dont le « sshd » ne répond pas.' };
}

/**
 * Une session ouverte vers un Spark.
 *
 * Elle ne retient JAMAIS ce qui transite : ni les octets saisis, ni la sortie,
 * ni un extrait. Le §37.5 l'exige, et le code doit rendre cette fuite impossible
 * plutôt qu'improbable — d'où l'absence de tout tampon d'historique ici.
 */
/**
 * Sonde le `sshd` d'un Spark. C'est une MESURE, pas une supposition.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.3, §22.2 (ce qui vit se prouve
 *       à travers le chemin réel, jamais en constatant qu'un processus existe)
 *
 * Le sondage emprunte EXACTEMENT le chemin du terminal normal — même rebond,
 * même options —, et n'exécute que `true`. Sonder autrement mesurerait un autre
 * chemin que celui qu'on s'apprête à déclarer indisponible.
 *
 * Le verdict passe par `classerEchecSsh` : un refus de clé n'est pas un `sshd`
 * muet, et cette fonction ne tranche pas elle-même.
 */
export function sonderSshd({ tunnel, spark, spawn: spawnFn = spawn,
                             timeoutSecondes = 5 } = {}) {
  return new Promise((resoudre) => {
    const enfant = spawnFn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${timeoutSecondes}`,
      ...tunnel.jumpArgs(),
      `root@${spark.ipv4_address}`,
      'true',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let erreurs = '';
    enfant.stderr?.on('data', (bloc) => { erreurs += bloc.toString('utf8'); });
    enfant.on('exit', (code) => resoudre(classerEchecSsh(code, erreurs)));
    // `ssh` introuvable : on ne peut RIEN conclure du `sshd` distant, et
    // surtout pas qu'il est muet. Le §37.3 n'ouvrirait alors le dépannage que
    // parce que la console est mal installée.
    enfant.on('error', (erreur) => resoudre({ repond: true, motif: 'inconnu',
                                              detail: erreur.message }));
  });
}

export class Session {
  #child = null;
  #abonnes = new Set();
  #minuterie = null;
  #preavis = null;

  constructor({ tunnel, spark, spawn: spawnFn = spawn, commande = null,
                chemin = CHEMIN_SSH, motifDepannage = null,
                inactiviteMs = INACTIVITE_MS, preavisMs = PREAVIS_MS,
                maintenant = () => Date.now() } = {}) {
    if (!tunnel) throw new TerminalError('Aucun tunnel : le Spark est injoignable.');
    if (!spark) throw new TerminalError('Aucun Spark visé.');
    // §37.4.4 : l'identifiant est OPAQUE et imprévisible. Il ouvre un shell ;
    // le dériver du nom du Spark reviendrait à le donner à qui connaît ce nom.
    this.id = randomBytes(16).toString('hex');
    this.tunnel = tunnel;
    this.spark = spark;
    this.ouvertA = maintenant();
    this.fermeA = null;
    this.motif = null;
    this.derniereActivite = this.ouvertA;
    this.spawnFn = spawnFn;
    // §37.4.2 bis : le doublon remplace la COMMANDE lancée, pas le mécanisme.
    // Tout le reste du chemin est celui qui tournera en production.
    this.commande = commande;
    // §37.3 : le chemin employé est retenu pour TOUTE la session. La bannière
    // doit rester visible jusqu'au bout — « on ne doit pas oublier par quel
    // chemin on est entré » —, et le journal doit pouvoir le nommer à la
    // fermeture comme à l'ouverture.
    if (chemin !== CHEMIN_SSH && chemin !== CHEMIN_DEPANNAGE) {
      throw new TerminalError(`Chemin d'entrée inconnu : « ${chemin} ».`);
    }
    this.chemin = chemin;
    this.motifDepannage = chemin === CHEMIN_DEPANNAGE ? motifDepannage : null;
    this.inactiviteMs = inactiviteMs;
    this.preavisMs = preavisMs;
    this.maintenant = maintenant;
  }

  /**
   * Arguments de `ssh`. Aucun secret : la configuration du poste fait foi,
   * comme pour le tunnel (§22.1).
   *
   * `-tt` force l'allocation d'un pseudo-terminal SUR LE SPARK : c'est le côté
   * distant qui le fournit, et c'est ce qui évite un module natif ici (§37.4.2).
   */
  sshArgs() {
    return [
      '-tt',
      // Aucune invite : la console n'a pas de terminal où saisir une phrase de
      // passe, et une invite bloquerait la session sans que rien ne le dise.
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      // Le rebond vient du TUNNEL : c'est lui qui sait comment on atteint sa
      // Forge, et le dupliquer ici ferait diverger les deux (§17.4).
      ...this.tunnel.jumpArgs(),
      `root@${this.spark.ipv4_address}`,
    ];
  }

  /**
   * Arguments du chemin de DÉPANNAGE (§37.3).
   *
   * La destination n'est plus le Spark mais la FORGE : c'est elle qui commande
   * Incus. On lui fait exécuter `incus exec <cellule> -- <shell>`, ce qui donne
   * un shell root DANS la cellule sans passer par son `sshd` — précisément le
   * cas où il n'y en a pas.
   *
   * `--` est obligatoire et n'est pas décoratif : sans lui, `incus` interprète
   * les options du shell comme les siennes.
   *
   * Sur une Forge LOCALE il n'y a aucun `ssh` : `incus` s'exécute ici. C'est
   * `forgeArgs()` qui porte la distinction, en rendant une liste vide.
   */
  rescueArgs() {
    const surLaForge = ['incus', 'exec', this.spark.incus_name, '--', '/bin/bash'];
    const forge = this.tunnel.forgeArgs();
    if (!forge.length) return { programme: surLaForge[0], arguments_: surLaForge.slice(1) };
    return {
      programme: 'ssh',
      arguments_: [
        '-tt',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        ...forge,
        ...surLaForge,
      ],
    };
  }

  /** Le couple programme/arguments du chemin retenu à l'ouverture. */
  argv() {
    if (this.commande) {
      const [programme, ...arguments_] = this.commande.split(/\s+/);
      return { programme, arguments_ };
    }
    if (this.chemin === CHEMIN_DEPANNAGE) return this.rescueArgs();
    return { programme: 'ssh', arguments_: this.sshArgs() };
  }

  demarrer() {
    const { programme, arguments_ } = this.argv();
    this.#child = this.spawnFn(programme, arguments_, { stdio: ['pipe', 'pipe', 'pipe'] });
    const pousser = (canal) => (bloc) => this.#diffuser(canal, bloc.toString('utf8'));
    this.#child.stdout?.on('data', pousser('sortie'));
    // La sortie d'erreur de `ssh` porte le motif d'un refus — « clé refusée »,
    // « connexion fermée ». La taire obligerait à deviner (§22.3).
    this.#child.stderr?.on('data', pousser('sortie'));
    this.#child.on('exit', () => this.fermer(DISTANT_TERMINE));
    this.#child.on('error', (erreur) => {
      this.#diffuser('sortie',
        `\r\n[la console n'a pas pu lancer ${programme} : ${erreur.message}]\r\n`);
      this.fermer(DISTANT_TERMINE);
    });
    this.#armerInactivite();
    return this;
  }

  /** Abonne un flux d'évènements. Le retour se désabonne. */
  abonner(envoyer) {
    this.#abonnes.add(envoyer);
    return () => this.#abonnes.delete(envoyer);
  }

  #diffuser(type, data) {
    for (const envoyer of this.#abonnes) {
      try {
        envoyer(type, data);
      } catch {
        // Un abonné rompu ne doit pas emporter les autres NI la session : le
        // flux se referme de lui-même, et le §37.4.2 s'en charge.
        this.#abonnes.delete(envoyer);
      }
    }
  }

  /** Les octets saisis. Ils traversent, rien ne les retient (§37.5). */
  ecrire(data) {
    if (!this.#child || this.fermeA) {
      throw new TerminalError('La session est fermée.');
    }
    this.#child.stdin?.write(data);
    this.#armerInactivite();
  }

  /**
   * Redimensionne, avec la limite du §37.4.3 : `stty` ne réveille pas un
   * programme plein écran DÉJÀ en cours, qui ne recevra pas `SIGWINCH`.
   */
  redimensionner(rows, cols) {
    for (const [nom, valeur] of [['rows', rows], ['cols', cols]]) {
      if (!Number.isInteger(valeur) || valeur < 1 || valeur > 1000) {
        throw new TerminalError(`Taille « ${nom} = ${valeur} » hors bornes : 1 à 1000.`);
      }
    }
    this.ecrire(`stty rows ${rows} cols ${cols}\n`);
  }

  #armerInactivite() {
    this.derniereActivite = this.maintenant();
    clearTimeout(this.#minuterie);
    clearTimeout(this.#preavis);
    if (!this.inactiviteMs) return;
    // §37.4.2 : l'avertissement est affiché AVANT, jamais après. Fermer sans
    // prévenir ferait perdre ce qui était en cours de frappe.
    this.#preavis = setTimeout(() => {
      this.#diffuser('avertissement',
        `Cette session se fermera dans ${Math.round(this.preavisMs / 1000)} s `
        + "faute d'activité. Une touche suffit à la conserver.");
    }, Math.max(0, this.inactiviteMs - this.preavisMs));
    this.#preavis.unref?.();
    this.#minuterie = setTimeout(() => this.fermer(INACTIVITE), this.inactiviteMs);
    this.#minuterie.unref?.();
  }

  /** Ferme, et TUE le distant. C'est le contrat du §37.4. */
  fermer(motif = SORTIE) {
    if (this.fermeA) return this;
    this.fermeA = this.maintenant();
    this.motif = motif;
    clearTimeout(this.#minuterie);
    clearTimeout(this.#preavis);
    try {
      this.#child?.kill('SIGKILL');
    } catch { /* déjà mort : rien à tuer */ }
    this.#diffuser('fin', motif);
    this.#abonnes.clear();
    return this;
  }

  /** Durée en secondes, pour le journal (§37.4.5). */
  dureeSecondes() {
    return Math.max(0, Math.round(((this.fermeA ?? this.maintenant()) - this.ouvertA) / 1000));
  }

  /**
   * Ce que l'écran a le droit de savoir. AUCUN contenu n'y figure, et c'est
   * éprouvé : le §37.5 en fait une règle, pas une intention.
   */
  describe() {
    return {
      id: this.id, spark: this.spark.name,
      // §37.3 : le chemin RÉELLEMENT emprunté, pas une constante. C'est lui qui
      // fait tenir la bannière toute la session, et c'est lui que le journal
      // reçoit — un « ssh » écrit en dur mentirait sur les deux.
      path: this.chemin,
      rescueReason: this.motifDepannage,
      openedAt: new Date(this.ouvertA).toISOString(),
      closed: Boolean(this.fermeA), reason: this.motif,
      durationSeconds: this.dureeSecondes(),
    };
  }
}


/** Les sessions vivantes, et rien d'autre. */
export class SessionManager {
  #sessions = new Map();

  constructor({ spawn: spawnFn = spawn, commande = null,
                inactiviteMs = INACTIVITE_MS,
                preavisMs = PREAVIS_MS, maintenant = () => Date.now() } = {}) {
    this.spawnFn = spawnFn;
    this.commande = commande;
    // §37.4.2 bis : le doublon remplace la COMMANDE lancée, pas le mécanisme.
    // Tout le reste du chemin est celui qui tournera en production.
    this.commande = commande;
    this.inactiviteMs = inactiviteMs;
    this.preavisMs = preavisMs;
    this.maintenant = maintenant;
  }

  ouvrir({ tunnel, spark, chemin = CHEMIN_SSH, motifDepannage = null }) {
    const session = new Session({
      tunnel, spark, spawn: this.spawnFn, commande: this.commande,
      chemin, motifDepannage,
      inactiviteMs: this.inactiviteMs,
      preavisMs: this.preavisMs, maintenant: this.maintenant,
    }).demarrer();
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id) {
    const session = this.#sessions.get(id);
    if (!session) throw new TerminalError(`Aucune session « ${id} ».`);
    return session;
  }

  fermer(id, motif = SORTIE) {
    const session = this.#sessions.get(id);
    if (!session) return null;
    session.fermer(motif);
    this.#sessions.delete(id);
    return session;
  }

  list() {
    return [...this.#sessions.values()].map((s) => s.describe());
  }

  /** Ferme TOUT : l'hôte console s'arrête, aucun shell ne lui survit. */
  fermerToutes() {
    for (const id of [...this.#sessions.keys()]) this.fermer(id, FLUX_FERME);
  }
}
