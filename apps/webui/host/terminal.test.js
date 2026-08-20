/**
 * @verifies docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.1 (la console parle au
 *           Spark, pas `sparkd`), §37.4 (le contrat du terminal),
 *           §37.4.2 (ce qui tue une session), §37.4.3 (la limite du
 *           redimensionnement), §37.4.4 (l'identifiant opaque) ·
 *           §37.5 (l'ouverture et la fermeture, RIEN du contenu) · §17.4
 *
 * LA preuve de cette unité : rien de ce qui est tapé ne ressort. Le §37.5 en
 * fait une règle parce que le caviardage du §21.2 travaille sur des champs
 * nommés et ne saura jamais nettoyer un flux interactif.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  DISTANT_TERMINE, FLUX_FERME, INACTIVITE, Session, SessionManager,
  SORTIE, TerminalError,
} from './terminal.js';

const SPARK = { name: 'crm', ipv4_address: '10.77.0.16' };

function fauxSsh() {
  const e = new EventEmitter();
  e.stdout = new EventEmitter();
  e.stderr = new EventEmitter();
  e.stdin = { ecrit: [], write(d) { this.ecrit.push(String(d)); } };
  e.tue = [];
  e.kill = (signal) => e.tue.push(signal);
  return e;
}

function pile({ tunnel, ...options } = {}) {
  const enfants = [];
  const spawnFn = (commande, args) => {
    const enfant = fauxSsh();
    enfant.commande = commande;
    enfant.args = args;
    enfants.push(enfant);
    return enfant;
  };
  const manager = new SessionManager({ spawn: spawnFn, ...options });
  const session = manager.ouvrir({
    tunnel: tunnel ?? { jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] },
    spark: SPARK,
  });
  return { manager, session, enfant: enfants[0], enfants };
}

// --- le transport (§37.1, §37.2, §17.4) -------------------------------------

test('la session lance « ssh -tt » vers le Spark, PAR REBOND sur sa Forge', () => {
  // §17.4 : un Spark n'expose jamais son port 22. Et §37.1 : c'est la console
  // qui parle au Spark — `sparkd` n'est pas dans ce chemin.
  const { enfant } = pile();
  assert.equal(enfant.commande, 'ssh');
  assert.ok(enfant.args.includes('-tt'), 'le pseudo-terminal vient du SPARK');
  assert.deepEqual(enfant.args.slice(-3), ['-J', 'ubuntu@203.0.113.10:22', 'root@10.77.0.16']);
  assert.ok(enfant.args.includes('BatchMode=yes'),
    'aucune invite : la console n’a pas de terminal où saisir une phrase de passe');
});

test('un serveur LOCAL n’a pas de rebond : le réseau privé est joignable', () => {
  const { enfant } = pile({ tunnel: { jumpArgs: () => [] } });
  assert.ok(!enfant.args.includes('-J'));
  assert.equal(enfant.args.at(-1), 'root@10.77.0.16');
});

test('l’identifiant est OPAQUE et ne dérive pas du nom du Spark', () => {
  // §37.4.4 : il ouvre un shell. Le deviner reviendrait à l'obtenir.
  const a = pile().session.id;
  const b = pile().session.id;
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.ok(!a.includes('crm'));
});

// --- LE contrat : rien du contenu ne ressort (§37.5) ------------------------

test('ce que la session DÉCRIT ne porte aucun contenu', () => {
  // Le §37.5 en fait une règle, pas une intention : le journal dira qu'une
  // session a eu lieu, jamais ce qui y a été fait.
  const { session, enfant } = pile();
  session.ecrire('mysql -u root -pSECRET-EN-CLAIR\n');
  enfant.stdout.emit('data', Buffer.from('mot de passe accepté, base ouverte'));

  const vu = JSON.stringify(session.describe());
  assert.ok(!vu.includes('SECRET-EN-CLAIR'), 'aucune frappe ne doit ressortir');
  assert.ok(!vu.includes('mot de passe accepté'), 'aucune sortie ne doit ressortir');
  assert.deepEqual(Object.keys(session.describe()).sort(),
    ['closed', 'durationSeconds', 'id', 'openedAt', 'path', 'reason', 'spark']);
});

test('la session ne retient AUCUN historique, même en mémoire', () => {
  // Le module n'a pas de tampon : un historique existant finirait par être
  // rendu, journalisé ou joint à un rapport de bogue.
  const { session, enfant } = pile();
  session.ecrire('secret-tapé');
  enfant.stdout.emit('data', Buffer.from('secret-affiché'));
  const tout = JSON.stringify(session, (_c, v) => (typeof v === 'function' ? undefined : v));
  assert.ok(!tout.includes('secret-tapé'));
  assert.ok(!tout.includes('secret-affiché'));
});

test('les octets TRAVERSENT : ce qui est tapé arrive au distant', () => {
  const { session, enfant } = pile();
  session.ecrire('ls -la\n');
  assert.deepEqual(enfant.stdin.ecrit, ['ls -la\n']);
});

test('la sortie est diffusée aux abonnés, y compris celle d’erreur de ssh', () => {
  // La sortie d'erreur porte le motif d'un refus — « clé refusée ». La taire
  // obligerait à deviner (§22.3).
  const { session, enfant } = pile();
  const vus = [];
  session.abonner((type, data) => vus.push([type, data]));
  enfant.stdout.emit('data', Buffer.from('bonjour'));
  enfant.stderr.emit('data', Buffer.from('Permission denied (publickey).'));
  assert.deepEqual(vus, [['sortie', 'bonjour'], ['sortie', 'Permission denied (publickey).']]);
});

// --- ce qui TUE une session (§37.4, §37.4.2) --------------------------------

test('fermer TUE le distant', () => {
  // Une session qui survivrait à son écran serait un shell root abandonné dont
  // personne ne se souvient.
  const { manager, session, enfant } = pile();
  manager.fermer(session.id);
  assert.deepEqual(enfant.tue, ['SIGKILL']);
  assert.equal(session.motif, SORTIE);
  assert.equal(session.describe().closed, true);
});

test('le distant qui se termine ferme la session, avec SON motif', () => {
  const { session, enfant } = pile();
  const vus = [];
  session.abonner((type, data) => vus.push([type, data]));
  enfant.emit('exit', 0);
  assert.equal(session.motif, DISTANT_TERMINE);
  assert.deepEqual(vus.at(-1), ['fin', DISTANT_TERMINE]);
});

test('l’arrêt de l’hôte console ne laisse AUCUN shell derrière lui', () => {
  const { manager, enfants } = pile();
  manager.ouvrir({ tunnel: { jumpArgs: () => [] }, spark: SPARK });
  manager.fermerToutes();
  assert.equal(manager.list().length, 0);
  assert.ok(enfants.every((e) => e.tue.includes('SIGKILL')));
});

test('écrire dans une session fermée est REFUSÉ, pas ignoré', () => {
  const { manager, session } = pile();
  manager.fermer(session.id);
  assert.throws(() => session.ecrire('x'), TerminalError);
});

test('une session inconnue est refusée en la nommant', () => {
  const { manager } = pile();
  assert.throws(() => manager.get('inexistante'), /Aucune session/);
  assert.equal(manager.fermer('inexistante'), null);
});

// --- l'inactivité, annoncée AVANT (§37.4.2) ---------------------------------

test('l’avertissement d’inactivité arrive AVANT la fermeture, pas après', async () => {
  // Fermer sans prévenir ferait perdre ce qui était en cours de frappe.
  const { session } = pile({ inactiviteMs: 60, preavisMs: 40 });
  const vus = [];
  session.abonner((type, data) => vus.push([type, data]));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(vus[0][0], 'avertissement');
  assert.match(vus[0][1], /se fermera dans/);
  assert.deepEqual(vus.at(-1), ['fin', INACTIVITE]);
});

test('une frappe REPOUSSE la fermeture pour inactivité', async () => {
  const { session } = pile({ inactiviteMs: 80, preavisMs: 40 });
  await new Promise((r) => setTimeout(r, 50));
  session.ecrire('x');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(session.describe().closed, false, 'la session doit avoir survécu');
  session.fermer();
});

// --- le redimensionnement, et sa limite (§37.4.3) ---------------------------

test('le redimensionnement passe par « stty » sur le canal d’entrée', () => {
  const { session, enfant } = pile();
  session.redimensionner(40, 120);
  assert.deepEqual(enfant.stdin.ecrit, ['stty rows 40 cols 120\n']);
});

test('une taille hors bornes est refusée en NOMMANT la dimension', () => {
  const { session } = pile();
  assert.throws(() => session.redimensionner(0, 80), /rows = 0/);
  assert.throws(() => session.redimensionner(24, 5000), /cols = 5000/);
});

// --- ce que le journal recevra (§37.4.5) ------------------------------------

test('la durée est mesurée, et elle est la seule grandeur de la session', () => {
  let horloge = 1_000_000;
  const { manager, session } = pile({ maintenant: () => horloge });
  horloge += 42_000;
  manager.fermer(session.id);
  assert.equal(session.dureeSecondes(), 42);
  assert.equal(session.describe().durationSeconds, 42);
});

test('le flux fermé est un motif DISTINCT d’une sortie volontaire', () => {
  // Le §37.4.5 les journalise séparément : « l'onglet a été fermé » et « le
  // shell s'est terminé » ne se diagnostiquent pas pareil.
  const { manager, session } = pile();
  manager.fermer(session.id, FLUX_FERME);
  assert.equal(session.describe().reason, FLUX_FERME);
});
