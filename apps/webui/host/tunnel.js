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

export class Tunnel {
  #child = null;
  #timer = null;

  constructor(server, options = {}) {
    this.server = server;
    this.state = CLOSED;
    this.localPort = null;
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
    return [
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=2',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.server.remotePort}`,
      '-p', String(this.server.port),
      `${this.server.user}@${this.server.host}`,
    ];
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
      this.#setState(CONNECTING);
      this.lastError = null;
      this.#timer = setInterval(() => this.probe(), this.probeIntervalMs);
      this.#timer.unref?.();
      await this.probe();
      return this;
    }

    this.localPort = await freePort();
    this.#setState(CONNECTING);
    this.lastError = null;

    this.#child = this.spawnFn('ssh', this.sshArgs(this.localPort), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    // On retient la sortie d'erreur de `ssh` : c'est elle qui dit « clé
    // refusée » ou « hôte inconnu », et la taire obligerait l'exploitant à
    // relancer la commande à la main pour la lire.
    this.#child.stderr?.on('data', (bloc) => {
      const texte = String(bloc).trim();
      if (texte) this.lastError = texte;
    });
    this.#child.on('exit', (code) => {
      if (this.state !== CLOSED) {
        this.lastError = this.lastError ?? `ssh s'est arrêté (code ${code}).`;
        this.#setState(BROKEN);
      }
    });
    this.#child.on('error', (erreur) => {
      this.lastError = `ssh est introuvable ou n'a pas pu démarrer : ${erreur.message}`;
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
        this.#setState(READY);
        return this.state;
      } catch (erreur) {
        this.lastError = erreur.message;
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
      this.#setState(READY);
    } catch (erreur) {
      this.lastError = erreur.message;
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
  }

  /** Ce que la console affiche. Jamais un état deviné. */
  describe() {
    return {
      name: this.server.name,
      host: this.server.host,
      state: this.state,
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
