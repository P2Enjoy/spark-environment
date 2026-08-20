/**
 * Sessions de terminal vers un Spark, portées par l'hôte console.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.1 (la frontière tient : c'est
 *       la CONSOLE qui parle au Spark, pas `sparkd`), §37.2 (le chemin normal :
 *       SSH, et ce qu'il suppose), §37.4 (le contrat du terminal),
 *       §37.4.1 (le transport), §37.4.2 (ce qui crée et ce qui tue une session),
 *       §37.4.3 (la limite du redimensionnement), §37.4.5 (ce que le journal
 *       reçoit) · §37.5 (l'ouverture et la fermeture, RIEN du contenu)
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
 * Une session ouverte vers un Spark.
 *
 * Elle ne retient JAMAIS ce qui transite : ni les octets saisis, ni la sortie,
 * ni un extrait. Le §37.5 l'exige, et le code doit rendre cette fuite impossible
 * plutôt qu'improbable — d'où l'absence de tout tampon d'historique ici.
 */
export class Session {
  #child = null;
  #abonnes = new Set();
  #minuterie = null;
  #preavis = null;

  constructor({ tunnel, spark, spawn: spawnFn = spawn, commande = null,
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

  demarrer() {
    const [programme, ...arguments_] = this.commande
      ? this.commande.split(/\s+/)
      : ['ssh', ...this.sshArgs()];
    this.#child = this.spawnFn(programme, arguments_, { stdio: ['pipe', 'pipe', 'pipe'] });
    const pousser = (canal) => (bloc) => this.#diffuser(canal, bloc.toString('utf8'));
    this.#child.stdout?.on('data', pousser('sortie'));
    // La sortie d'erreur de `ssh` porte le motif d'un refus — « clé refusée »,
    // « connexion fermée ». La taire obligerait à deviner (§22.3).
    this.#child.stderr?.on('data', pousser('sortie'));
    this.#child.on('exit', () => this.fermer(DISTANT_TERMINE));
    this.#child.on('error', (erreur) => {
      this.#diffuser('sortie', `\r\n[la console n'a pas pu lancer ssh : ${erreur.message}]\r\n`);
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
      id: this.id, spark: this.spark.name, path: 'ssh',
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

  ouvrir({ tunnel, spark }) {
    const session = new Session({
      tunnel, spark, spawn: this.spawnFn, commande: this.commande,
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
