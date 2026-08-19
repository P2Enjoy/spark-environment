/**
 * @verifies docs/BACKLOG.md#SPK-16 · docs/DAT.md §22.2, §22.3, §22.5
 *
 * Le cas qui compte : un processus `ssh` FIGE ne se voit pas. Il vit, la socket
 * accepte, et chaque requete attend. Ces tests verifient qu'on le detecte quand
 * meme — sans quoi la console afficherait un tunnel sain devant un service
 * injoignable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Tunnel, TunnelManager, TunnelError, freePort, READY, BROKEN, CLOSED , lireEmpreinte } from './tunnel.js';

const SERVEUR = { name: 'prod', host: '203.0.113.10', user: 'ubuntu', port: 22, remotePort: 9876 };

/** Faux sous-processus `ssh` : vivant, silencieux, exactement comme un vrai. */
function fauxSsh() {
  const enfant = new EventEmitter();
  enfant.stderr = new EventEmitter();
  enfant.kill = () => { enfant.tue = true; };
  return enfant;
}

function tunnel(options = {}) {
  return new Tunnel(SERVEUR, {
    spawn: () => fauxSsh(),
    probe: async () => ({ status: 'ok' }),
    probeIntervalMs: 3_600_000,
    ...options,
  });
}

// --- port local (§22.5) -----------------------------------------------------

test('le port local est demande au systeme, pas pioche', async () => {
  const a = await freePort();
  const b = await freePort();
  assert.ok(a > 1024 && a < 65536);
  assert.ok(b > 1024);
});

// --- la commande ssh (§22.1) ------------------------------------------------

test('la commande ne porte aucun secret et honore la config du poste', () => {
  const args = tunnel().sshArgs(19876);
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('127.0.0.1:19876:127.0.0.1:9876'));
  assert.ok(args.includes('ubuntu@203.0.113.10'));
  // Rien qui ressemble a une cle ou un mot de passe.
  assert.equal(args.some((a) => /-i\b|password|key/i.test(a)), false);
  // ExitOnForwardFailure : sans lui, ssh reussirait avec un port deja pris.
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
});

// --- LE cas dangereux : le tunnel fige (§22.2) ------------------------------

test('un processus ssh VIVANT mais fige est vu comme rompu', async () => {
  const t = tunnel({
    probe: async () => { throw new Error('délai dépassé'); },
  });
  await t.open();
  // Le sous-processus n'a jamais emis « exit » : il est bien vivant.
  assert.equal(t.state, BROKEN);
  assert.match(t.lastError, /délai dépassé/);
});

test('un tunnel sain est pret', async () => {
  const t = tunnel();
  await t.open();
  assert.equal(t.state, READY);
  assert.ok(t.lastHealthyAt !== null);
});

test('un tunnel devient rompu quand la sonde cesse de repondre', async () => {
  let sain = true;
  const t = tunnel({ probe: async () => { if (!sain) throw new Error('injoignable'); } });
  await t.open();
  assert.equal(t.state, READY);
  sain = false;
  await t.probe();
  assert.equal(t.state, BROKEN);
});

// --- la sortie d'erreur de ssh est retenue ----------------------------------

test("l'erreur rapportee par ssh est conservee", async () => {
  let enfant;
  const t = tunnel({ spawn: () => (enfant = fauxSsh()) });
  await t.open();
  enfant.stderr.emit('data', 'Permission denied (publickey).');
  enfant.emit('exit', 255);
  assert.equal(t.state, BROKEN);
  assert.match(t.lastError, /Permission denied/);
});

test('un ssh absent du poste est signale clairement', async () => {
  let enfant;
  const t = tunnel({ spawn: () => (enfant = fauxSsh()) });
  await t.open();
  enfant.emit('error', new Error('spawn ssh ENOENT'));
  assert.equal(t.state, BROKEN);
  assert.match(t.lastError, /introuvable/);
});

// --- une panne se signale, jamais masquee (§22.3) ---------------------------

test('une requete vers un tunnel rompu echoue IMMEDIATEMENT avec le motif', async () => {
  const gestion = new TunnelManager({
    spawn: () => fauxSsh(),
    probe: async () => { throw new Error('connexion refusée'); },
    probeIntervalMs: 3_600_000,
  });
  await gestion.open(SERVEUR);

  const debut = Date.now();
  assert.throws(
    () => gestion.require('prod'),
    (erreur) => {
      assert.ok(erreur instanceof TunnelError);
      assert.match(erreur.message, /indisponible/);
      assert.match(erreur.message, /broken/);
      assert.match(erreur.message, /connexion refusée/);
      return true;
    },
  );
  // Immediatement : pas d'attente d'un delai reseau.
  assert.ok(Date.now() - debut < 100);
});

test('un tunnel inconnu est refuse sans etre confondu avec un tunnel rompu', () => {
  assert.throws(() => new TunnelManager().require('fantome'), /Aucun tunnel ouvert/);
});

test("l'age de la derniere reponse est expose", async () => {
  const gestion = new TunnelManager({
    spawn: () => fauxSsh(), probe: async () => ({}), probeIntervalMs: 3_600_000,
  });
  await gestion.open(SERVEUR);
  const [etat] = gestion.list();
  assert.equal(etat.state, READY);
  assert.ok(etat.staleSeconds !== null);
  assert.ok(etat.localPort > 0);
});

// --- cycle de vie -----------------------------------------------------------

test('fermer un tunnel tue le sous-processus et libere le port', async () => {
  let enfant;
  const t = tunnel({ spawn: () => (enfant = fauxSsh()) });
  await t.open();
  t.close();
  assert.equal(t.state, CLOSED);
  assert.equal(enfant.tue, true);
  assert.equal(t.localPort, null);
});

test('les changements d etat sont notifies a la console', async () => {
  const vus = [];
  const t = tunnel({ onChange: (e) => vus.push(e.state) });
  await t.open();
  t.close();
  assert.deepEqual(vus, ['connecting', 'ready', 'closed']);
});

test('ouvrir deux fois le meme serveur ne lance pas deux ssh', async () => {
  let lances = 0;
  const gestion = new TunnelManager({
    spawn: () => { lances += 1; return fauxSsh(); },
    probe: async () => ({}), probeIntervalMs: 3_600_000,
  });
  await gestion.open(SERVEUR);
  await gestion.open(SERVEUR);
  assert.equal(lances, 1);
});

// --- etablissement (defaut trouve par le test reel) -------------------------

test('un tunnel lent a s ouvrir n est PAS declare rompu', async () => {
  // `ssh` met un instant a s'authentifier : sonder une seule fois juste apres
  // l'avoir lance mesure sa vitesse de demarrage, pas sa sante.
  let essais = 0;
  const t = tunnel({
    probe: async () => { if (++essais < 3) throw new Error('pas encore'); },
    openTimeoutMs: 5000,
  });
  await t.open();
  assert.equal(t.state, READY);
  assert.ok(essais >= 3);
});

test('on n attend pas un ssh deja mort', async () => {
  let enfant;
  const t = tunnel({
    spawn: () => { enfant = fauxSsh(); enfant.exitCode = 255; return enfant; },
    probe: async () => { throw new Error('refusé'); },
    openTimeoutMs: 30000,
  });
  const debut = Date.now();
  await t.open();
  assert.equal(t.state, BROKEN);
  assert.ok(Date.now() - debut < 2000, "on ne doit pas attendre l'échéance complète");
});

test('un tunnel qui ne s ouvre jamais finit rompu, dans un delai borne', async () => {
  const t = tunnel({
    probe: async () => { throw new Error('injoignable'); },
    openTimeoutMs: 600,
  });
  await t.open();
  assert.equal(t.state, BROKEN);
  assert.match(t.lastError, /injoignable/);
});

// --- le chemin d'acces LOCAL (docs/DAT.md §28.2) ----------------------------

test('un serveur local ne lance AUCUN ssh', async () => {
  let lance = 0;
  const t = new Tunnel({ name: 'dev', kind: 'local', host: '127.0.0.1', port: 9876 },
    { spawn: () => { lance += 1; return fauxSsh(); },
      probe: async () => {}, probeIntervalMs: 3_600_000 });
  await t.open();
  assert.equal(lance, 0, 'ouvrir un tunnel vers localhost n’accomplirait aucun transport');
  assert.equal(t.state, READY);
  assert.equal(t.localPort, 9876, 'le port est celui ou sparkd ecoute deja');
  t.close();
});

test('un serveur local SONDE quand meme : « ready » ne se pose pas sans preuve', async () => {
  const t = new Tunnel({ name: 'dev', kind: 'local', host: '127.0.0.1', port: 9876 },
    { spawn: () => fauxSsh(),
      probe: async () => { throw new Error('connexion refusee'); },
      probeIntervalMs: 3_600_000 });
  await t.open();
  assert.equal(t.state, BROKEN, 'un sparkd arrete ne doit pas paraitre joignable');
  assert.match(t.lastError, /connexion refusee/);
  t.close();
});

test('un serveur local se referme proprement, sans processus a tuer', async () => {
  const t = new Tunnel({ name: 'dev', kind: 'local', host: '127.0.0.1', port: 9876 },
    { spawn: () => fauxSsh(), probe: async () => {}, probeIntervalMs: 3_600_000 });
  await t.open();
  t.close();
  assert.equal(t.state, CLOSED);
});


// --- l'acteur déclaré au journal (SPK-37, docs/DAT.md §21.6.3) -------------

test("l'empreinte est relevée sur la ligne qu'OpenSSH émet en VERBOSE", () => {
  // Forme documentée d'OpenSSH sous LogLevel=VERBOSE. NON mesurée contre un
  // serveur SSH réel dans cet environnement : aucun sshd n'y répond.
  const ligne = 'debug1: Server accepts key: /home/p/.ssh/id_ed25519 ED25519 '
    + 'SHA256:AbCd12+/xyzABCDEFGHIJKLMNOPQRSTUVWXYZ012 agent';
  assert.equal(lireEmpreinte(ligne),
               'SHA256:AbCd12+/xyzABCDEFGHIJKLMNOPQRSTUVWXYZ012');
});

test("le CHEMIN de la clé n'est pas retenu", () => {
  // Il nomme un fichier du poste, pas une identité. Le journal n'a rien à faire
  // d'un chemin local, et l'y écrire fuiterait l'arborescence du responsable.
  const ligne = 'debug1: Server accepts key: /home/secret-user/.ssh/id_rsa RSA SHA256:Zz09';
  assert.equal(lireEmpreinte(ligne), 'SHA256:Zz09');
});

test('une ligne sans empreinte rend null, et ce N’EST PAS un échec', () => {
  // §21.6.3 : un tunnel local n'a pas de clé, un agent muet n'en donne aucune.
  // Écrire une empreinte plausible plutôt que rien serait le pire des deux.
  assert.equal(lireEmpreinte('debug1: Connecting to exemple port 22.'), null);
  assert.equal(lireEmpreinte(''), null);
  assert.equal(lireEmpreinte(null), null);
  assert.equal(lireEmpreinte(undefined), null);
});

test("l'acteur déclaré nomme le serveur, et la clé SEULEMENT si on la connaît", () => {
  const t = new Tunnel({ name: 'prod', host: 'h', user: 'u', port: 22, remotePort: 9876 });
  assert.equal(t.actorHeader, 'console/prod', 'sans empreinte, on ne nomme que le serveur');
  t.keyFingerprint = 'SHA256:AbCd';
  assert.equal(t.actorHeader, 'console/prod key=SHA256:AbCd');
});


// --- la connexion par alias (SPK-41, docs/DAT.md §22.4 bis) ----------------

test('un tunnel par ALIAS passe le Host tel quel, sans -p ni user@', () => {
  // Les ajouter ÉCRASERAIT ce que le ssh_config déclare — port, utilisateur,
  // rebond — et c'est précisément ce que le §22.4 bis lui délègue.
  const t = new Tunnel({ name: 'prod', kind: 'alias', sshHost: 'spark-prod',
                         remotePort: 9876 });
  const args = t.sshArgs(41000);
  assert.ok(args.includes('spark-prod'), 'le Host est passé tel quel');
  assert.ok(!args.includes('-p'), 'le port appartient au ssh_config');
  assert.ok(!args.some((a) => String(a).includes('@')), 'l’utilisateur aussi');
  assert.ok(args.includes('-L') && args.some((a) => String(a).includes('127.0.0.1:9876')),
    'la redirection vers sparkd reste celle du produit');
});

test('un tunnel par alias garde la vérification de la clé d’hôte', () => {
  // §22.4 bis : le produit ne pose ni StrictHostKeyChecking=no, ni
  // UserKnownHostsFile=/dev/null — pas même pour « simplifier la première
  // connexion ». Un changement de clé d’hôte est un signal.
  const args = new Tunnel({ name: 'p', kind: 'alias', sshHost: 'h', remotePort: 9876 })
    .sshArgs(41000).join(' ');
  assert.ok(!/StrictHostKeyChecking/.test(args));
  assert.ok(!/UserKnownHostsFile/.test(args));
});
