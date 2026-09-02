/**
 * Tunnels SSH vers les serveurs administrés.
 *
 * @spec docs/BACKLOG.md#SPK-16, docs/BACKLOG.md#SPK-23 ·
 *       docs/DAT.md §6 (Plan d'administration), §22.1 (le binaire ssh du
 *       système), §22.2 (un tunnel vivant se prouve à travers lui), §22.3 (une
 *       panne se signale), §22.5 (le port local), §28.2 (le serveur local)
 *
 * Le point important de ce module tient en une phrase : un processus `ssh`
 * FIGÉ ne se voit pas. Il vit, la socket locale accepte, et chaque requête
 * attend indéfiniment. Vérifier que le sous-processus est vivant ne prouve donc
 * rien — c'est exactement ce que ce cas met en défaut.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

export const CONNECTING = 'connecting';
export const READY = 'ready';
export const BROKEN = 'broken';
export const CLOSED = 'closed';
export const TRANSPORT_LOCAL = 'local';

const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

/**
 * `ssh` met un instant à s'authentifier et à ouvrir la redirection. Sonder une
 * seule fois juste après l'avoir lancé revient à mesurer sa vitesse de
 * démarrage, pas sa santé — et déclare rompu un tunnel qui se connecte.
 */
const OPEN_TIMEOUT_MS = 15000;
const OPEN_RETRY_MS = 300;

export class TunnelError extends Error {}

/** Demande un port libre au système (docs/DAT.md §22.5). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const serveur = createServer();
    serveur.once('error', reject);
    serveur.listen(0, '127.0.0.1', () => {
      const { port } = serveur.address();
      serveur.close(() => resolve(port));
    });
  });
}

/**
 * Empreinte de la clé qu'OpenSSH déclare acceptée (docs/DAT.md §21.6.3).
 *
 * @spec docs/BACKLOG.md#SPK-37 · docs/DAT.md §21.6.3
 *
 * Sous `LogLevel=VERBOSE`, OpenSSH émet une ligne de cette forme :
 *
 *     debug1: Server accepts key: /home/x/.ssh/id_ed25519 ED25519 SHA256:abc… agent
 *
 * On n'en retient que l'empreinte `SHA256:…`. Le chemin du fichier n'est pas
 * repris : il nomme un fichier du poste, pas l'identité, et le journal n'a rien
 * à faire d'un chemin local.
 *
 * Rend `null` quand rien ne correspond — et c'est un résultat, pas un échec :
 * un tunnel local n'a pas de clé, un agent muet n'en donne aucune. Le §21.6.3
 * l'exige, écrire une empreinte plausible plutôt que rien serait le pire des
 * deux mondes.
 */
export function lireEmpreinte(texte) {
  const ligne = /Server accepts key:.*?(SHA256:[A-Za-z0-9+/=]+)/.exec(String(texte ?? ''));
  return ligne ? ligne[1] : null;
}

export class Tunnel {
  #child = null;
  #timer = null;
  /**
   * Ce que `ssh` LUI-MÊME a dit, quand il a dit quelque chose.
   *
   * @spec docs/BACKLOG.md#SPK-16 · docs/DAT.md §22.3 (le motif d'une panne est
   *       l'erreur rapportée par `ssh`)
   *
   * MESURÉ le 2026-09-02 contre un hôte injoignable : la sonde échoue toutes
   * les cinq secondes et écrivait `fetch failed` par-dessus
   * « connect to host … : Connection refused ». L'écran ne montrait donc jamais
   * la seule phrase qui disait POURQUOI — remplacée par le nom d'un échec de
   * `fetch`, qui n'apprend rien à personne.
   */
  #motifSsh = null;

  constructor(server, options = {}) {
    this.server = server;
    this.state = CLOSED;
    // SPK-68 · §50.1 : l'authentification SSH et la réponse de sparkd ne sont
    // pas le même fait. `state` garde le contrat historique du plan de
    // contrôle ; cette valeur supplémentaire dit ce que le transport a établi.
    this.transportState = CLOSED;
    this.localPort = null;
    /** Empreinte relevée sur le flux d'OpenSSH ; `null` tant qu'inconnue. */
    this.keyFingerprint = null;
    this.lastHealthyAt = null;
    this.lastError = null;
    this.spawnFn = options.spawn ?? spawn;
    this.probeFn = options.probe ?? defaultProbe;
    this.probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
    this.openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    this.onChange = options.onChange ?? (() => {});
  }

  /** Argument de `ssh`. Aucun secret : la configuration du poste fait foi. */
  sshArgs(localPort) {
    // Une entrée par ALIAS ne nomme qu'un `Host` du ssh_config : on le passe tel
    // quel, sans `-p` ni `user@`. Les ajouter ÉCRASERAIT ce que le fichier
    // déclare — port, utilisateur, rebond — et le §22.4 bis délègue justement
    // cela à OpenSSH.
    if (this.server.kind === 'alias') {
      return [
        '-N',
        // SPK-37 · §21.6.3 : DEBUG1, et non VERBOSE. MESURÉ le 2026-08-21
        // contre un vrai sshd — VERBOSE n'émet qu'UNE ligne et jamais
        // « Server accepts key », qui est un message `debug1:`.
        '-o', 'LogLevel=DEBUG1',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=10',
        '-o', 'ServerAliveCountMax=2',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.server.remotePort}`,
        this.server.sshHost,
      ];
    }
    return [
      '-N',
      // SPK-37 · docs/DAT.md §21.6.3 : c'est cette verbosité qui fait dire à
      // OpenSSH QUELLE clé le serveur a acceptée. Sans elle, l'empreinte est
      // indéterminable et le journal ne peut nommer que le serveur.
      //
      // DEBUG1 et non VERBOSE : MESURÉ le 2026-08-21 contre un vrai sshd,
      // VERBOSE n'émet qu'UNE ligne — « Authenticated to … » — et jamais
      // « Server accepts key », qui est un message `debug1:`. La branche
      // « empreinte déterminée » ne se produisait donc JAMAIS.
      '-o', 'LogLevel=DEBUG1',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=2',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.server.remotePort}`,
      '-p', String(this.server.port),
      `${this.server.user}@${this.server.host}`,
    ];
  }

  /**
   * Arguments de REBOND pour atteindre un Spark de cette Forge.
   *
   * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §17.4 (aucun port SSH public :
   *       l'accès passe par rebond sur la Forge), §37.2
   *
   * C'est le tunnel qui sait comment on atteint SON serveur — la même
   * connaissance que `sshArgs`, sous une autre forme. La dupliquer ailleurs
   * ferait diverger les deux le jour où un genre de serveur change.
   *
   * Un serveur LOCAL n'a pas de rebond : la Forge est cette machine, et le
   * réseau privé des Sparks y est directement joignable.
   */
  jumpArgs() {
    if (this.isLocal) return [];
    if (this.server.kind === 'alias') return ['-J', this.server.sshHost];
    return ['-J', `${this.server.user}@${this.server.host}:${this.server.port}`];
  }

  /**
   * Arguments pour atteindre la FORGE elle-même, et non un Spark.
   *
   * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.3 (le dépannage par
   *       `incus exec`), §17.4, §22.1
   *
   * Le chemin de dépannage n'entre pas dans le Spark : il s'exécute SUR la
   * Forge, qui commande Incus. La destination change donc de nature — ce n'est
   * plus un rebond vers une adresse privée, c'est le serveur lui-même.
   *
   * Le retour est une LISTE, vide pour un serveur local, et c'est ce qui porte
   * la distinction : sur une Forge locale il n'y a pas de `ssh` à lancer du
   * tout, `incus` s'exécute ici. Rendre une destination factice obligerait
   * l'appelant à la reconnaître, donc à retenir la règle une seconde fois.
   */
  forgeArgs() {
    if (this.isLocal) return [];
    if (this.server.kind === 'alias') return [this.server.sshHost];
    // Le port n'est pas dans la destination : `ssh` le prend par `-p`, là où
    // `-J` l'accepte collé au nom. Les deux formes ne sont pas interchangeables.
    return ['-p', String(this.server.port), `${this.server.user}@${this.server.host}`];
  }

  /** Un serveur local n'a pas de transport à établir (docs/DAT.md §28.2). */
  get isLocal() {
    return this.server.kind === 'local';
  }

  async open() {
    if (this.state !== CLOSED && this.state !== BROKEN) return this;

    // Chemin LOCAL : `sparkd` écoute déjà sur la boucle locale de cette
    // machine. Il n'y a rien à rediriger, donc pas de `ssh` à lancer — mais la
    // santé se prouve de la MÊME façon, en interrogeant `/healthz` (§22.2). Un
    // « ready » posé sans sonder serait un succès simulé (§1.3 du design
    // system) : un sparkd arrêté paraîtrait joignable.
    if (this.isLocal) {
      this.localPort = this.server.port;
      this.transportState = TRANSPORT_LOCAL;
      this.#setState(CONNECTING);
      this.lastError = null;
      this.#timer = setInterval(() => this.probe(), this.probeIntervalMs);
      this.#timer.unref?.();
      await this.probe();
      return this;
    }

    this.localPort = await freePort();
    this.transportState = CONNECTING;
    this.#setState(CONNECTING);
    this.lastError = null;
    // Une réouverture ne traîne pas le motif de la précédente : il parlerait
    // d'une connexion qui n'existe plus.
    this.#motifSsh = null;

    this.#child = this.spawnFn('ssh', this.sshArgs(this.localPort), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    // On retient la sortie d'erreur de `ssh` : c'est elle qui dit « clé
    // refusée » ou « hôte inconnu », et la taire obligerait l'exploitant à
    // relancer la commande à la main pour la lire.
    this.#child.stderr?.on('data', (bloc) => {
      // LIGNE PAR LIGNE, et non bloc par bloc. Un bloc porte plusieurs lignes,
      // et n'en tester que la première rangeait dans `lastError` tout ce qui
      // suivait une ligne bénigne — `describe()` publie ce champ, donc l'écran
      // affichait un diagnostic sur un tunnel qui va bien (§14.5). Sous DEBUG1
      // le flux passe de 1 à 81 lignes : ce qui était rare devient la règle.
      for (const ligne of String(bloc).split('\n')) {
        const texte = ligne.trim();
        if (!texte) continue;
        // L'empreinte de la clé acceptée passe par ce même flux (§21.6.3). On la
        // relève au vol ; ce n'est PAS une erreur, et la ranger dans lastError
        // ferait afficher un diagnostic là où tout va bien.
        const empreinte = lireEmpreinte(texte);
        if (empreinte) { this.keyFingerprint = empreinte; continue; }
        if (texte.startsWith('debug')) continue;   // le reste de la verbosité
        // « Authenticated to … using "publickey" » est un SUCCÈS, pas une
        // panne. MESURÉ : c'était la seule ligne que VERBOSE émettait, et elle
        // atterrissait donc dans `lastError` à chaque tunnel qui s'ouvrait bien.
        if (/^Authenticated to /.test(texte)) {
          // OpenSSH ne formule cette ligne qu'après la clé d'hôte, la
          // négociation et l'authentification. Elle ne rend PAS sparkd sain :
          // le cas précisément recherché par SPK-68 est « SSH établi, API
          // absente ». L'état API reste donc `broken` si la sonde échoue.
          this.transportState = READY;
          continue;
        }
        this.#motifSsh = texte;
        this.lastError = texte;
      }
    });
    this.#child.on('exit', (code) => {
      if (this.state !== CLOSED) {
        this.#motifSsh = this.#motifSsh ?? `ssh s'est arrêté (code ${code}).`;
        this.lastError = this.#motifSsh;
        this.transportState = BROKEN;
        this.#setState(BROKEN);
      }
    });
    this.#child.on('error', (erreur) => {
      this.#motifSsh = `ssh est introuvable ou n'a pas pu démarrer : ${erreur.message}`;
      this.lastError = this.#motifSsh;
      this.transportState = BROKEN;
      this.#setState(BROKEN);
    });

    this.#timer = setInterval(() => this.probe(), this.probeIntervalMs);
    this.#timer.unref?.();
    await this.#waitReady();
    return this;
  }

  /**
   * Laisse au tunnel le temps de s'établir avant de conclure.
   *
   * On reste en `connecting` tant que la fenêtre n'est pas écoulée : un tunnel
   * qui met deux secondes à s'ouvrir n'est pas un tunnel rompu. On abandonne
   * dès que `ssh` s'arrête — inutile d'attendre un processus mort.
   */
  async #waitReady() {
    const echeance = Date.now() + (this.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    for (;;) {
      if (this.#child === null) return this.state;
      try {
        await this.probeFn(this.localPort, PROBE_TIMEOUT_MS);
        this.lastHealthyAt = Date.now();
        if (!this.isLocal) this.transportState = READY;
        this.#setState(READY);
        return this.state;
      } catch (erreur) {
        // §22.3 : ce que `ssh` a dit prime. « fetch failed » nomme l'outil qui a
        // échoué, jamais la cause ; le motif, lui, la nomme.
        this.lastError = this.#motifSsh ?? erreur.message;
        if (this.#child?.exitCode !== null && this.#child?.exitCode !== undefined) {
          this.#setState(BROKEN);
          return this.state;
        }
        if (Date.now() >= echeance) {
          this.#setState(BROKEN);
          return this.state;
        }
        await new Promise((r) => setTimeout(r, OPEN_RETRY_MS));
      }
    }
  }

  /**
   * Interroge `/healthz` À TRAVERS le tunnel.
   *
   * C'est la seule vérification qui distingue un tunnel figé d'un tunnel sain
   * (docs/DAT.md §22.2).
   */
  async probe() {
    if (this.state === CLOSED || this.localPort === null) return this.state;
    try {
      await this.probeFn(this.localPort, PROBE_TIMEOUT_MS);
      this.lastHealthyAt = Date.now();
      if (!this.isLocal) this.transportState = READY;
      this.#setState(READY);
    } catch (erreur) {
      // Idem §22.3 : la sonde qui échoue toutes les cinq secondes ne doit pas
      // effacer la phrase d'`ssh`, qui est la seule à dire pourquoi.
      this.lastError = this.#motifSsh ?? erreur.message;
      this.#setState(BROKEN);
    }
    return this.state;
  }

  close() {
    this.#setState(CLOSED);
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#child?.kill('SIGTERM');
    this.#child = null;
    this.localPort = null;
    this.transportState = CLOSED;
  }

  /** Ce que la console affiche. Jamais un état deviné. */
  /**
   * Ce que l'hôte console DÉCLARE comme acteur (docs/DAT.md §21.6.3).
   *
   * Le serveur toujours, l'empreinte seulement si elle est connue. Un tunnel
   * local n'en a aucune, un agent muet n'en donne aucune, et dans ces cas on ne
   * nomme que le serveur — on n'invente pas.
   */
  get actorHeader() {
    const base = `console/${this.server.name}`;
    // ASCII : un en-tête HTTP ne transporte pas d'accent, et une identité qui
    // casse l'appel qu'elle devait attribuer serait pire qu'aucune identité.
    return this.keyFingerprint ? `${base} key=${this.keyFingerprint}` : base;
  }

  describe() {
    return {
      name: this.server.name,
      host: this.server.host,
      state: this.state,
      transportState: this.transportState,
      localPort: this.localPort,
      lastHealthyAt: this.lastHealthyAt,
      lastError: this.lastError,
      staleSeconds:
        this.lastHealthyAt === null ? null : Math.round((Date.now() - this.lastHealthyAt) / 1000),
    };
  }

  #setState(etat) {
    if (this.state === etat) return;
    this.state = etat;
    this.onChange(this.describe());
  }
}

async function defaultProbe(localPort, timeoutMs) {
  const arret = AbortSignal.timeout(timeoutMs);
  const reponse = await fetch(`http://127.0.0.1:${localPort}/healthz`, { signal: arret });
  if (!reponse.ok) throw new TunnelError(`/healthz a rendu ${reponse.status}.`);
  return reponse.json();
}

export class TunnelManager {
  #tunnels = new Map();

  constructor(options = {}) {
    this.options = options;
  }

  async open(server) {
    const existant = this.#tunnels.get(server.name);
    if (existant) return existant;
    const tunnel = new Tunnel(server, this.options);
    this.#tunnels.set(server.name, tunnel);
    await tunnel.open();
    return tunnel;
  }

  get(name) {
    return this.#tunnels.get(name) ?? null;
  }

  /**
   * Rend le tunnel PRÊT, ou refuse en disant pourquoi.
   *
   * Une requête vers un tunnel rompu échoue immédiatement : elle n'attend pas
   * l'expiration d'un délai réseau, et le motif accompagne le refus
   * (docs/DAT.md §22.3).
   */
  require(name) {
    const tunnel = this.#tunnels.get(name);
    if (!tunnel) throw new TunnelError(`Aucun tunnel ouvert vers « ${name} ».`);
    if (tunnel.state !== READY) {
      const etat = tunnel.describe();
      const depuis =
        etat.staleSeconds === null
          ? "jamais joint depuis l'ouverture"
          : `dernière réponse il y a ${etat.staleSeconds} s`;
      throw new TunnelError(
        `Tunnel vers « ${name} » indisponible (${etat.state}, ${depuis}). ` +
          `${etat.lastError ?? ''}`.trim(),
      );
    }
    return tunnel;
  }

  close(name) {
    this.#tunnels.get(name)?.close();
    this.#tunnels.delete(name);
  }

  closeAll() {
    for (const nom of [...this.#tunnels.keys()]) this.close(nom);
  }

  list() {
    return [...this.#tunnels.values()].map((t) => t.describe());
  }
}
