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
  CHEMIN_DEPANNAGE, CHEMIN_SSH, classerEchecSsh, commandePour, depannageOuvert,
  DISTANT_TERMINE, EN_ERREUR, FLUX_FERME, INACTIVITE, Session, SessionManager,
  sonderSshd, SORTIE, SSHD_MUET, CLE_HOTE_CHANGEE, TerminalError,
} from './terminal.js';

const SPARK = { name: 'crm', ipv4_address: '10.77.0.16' };

function fauxSsh() {
  const e = new EventEmitter();
  e.stdout = new EventEmitter();
  e.stderr = new EventEmitter();
  e.stdin = { ecrit: [], write(d) { this.ecrit.push(String(d)); } };
  e.tue = [];
  e.kill = (signal) => e.tue.push(signal);
  // Le double garde aussi l'interface d'un PTY : la sortie est un seul flux,
  // et la taille est un appel dédié, jamais une commande tapée dans le shell.
  e.onData = (ecouter) => {
    const sortie = (data) => ecouter(String(data));
    e.stdout.on('data', sortie); e.stderr.on('data', sortie);
    return { dispose: () => { e.stdout.off('data', sortie); e.stderr.off('data', sortie); } };
  };
  e.onExit = (ecouter) => {
    const sortie = (code, signal) => ecouter({ exitCode: code ?? 0, signal: signal ?? null });
    e.on('exit', sortie);
    return { dispose: () => e.off('exit', sortie) };
  };
  e.write = (data) => e.stdin.write(data);
  e.redimensionnements = [];
  e.resize = (cols, rows) => e.redimensionnements.push({ cols, rows });
  return e;
}

function pile({ tunnel, spark, chemin, motifDepannage,
                conteneur, shell, ...options } = {}) {
  const enfants = [];
  const spawnFn = (commande, args) => {
    const enfant = fauxSsh();
    enfant.commande = commande;
    enfant.args = args;
    enfants.push(enfant);
    return enfant;
  };
  const manager = new SessionManager({ ptySpawn: spawnFn, ...options });
  const session = manager.ouvrir({
    tunnel: tunnel ?? { jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] },
    spark: spark ?? SPARK, chemin, motifDepannage, conteneur, shell,
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
  // RÉVISÉE le 2026-08-20, tranche 4 de SPK-43 : `rescueReason` s'ajoute au
  // contrat. Le §37.3 exige que le chemin de dépannage soit distingué, et son
  // motif doit voyager jusqu'à l'écran — la bannière le nomme — et jusqu'au
  // journal. La liste est donc allongée, PAS relâchée : elle reste exhaustive,
  // et c'est elle qui interdit qu'un champ libre s'y glisse un jour.
  //
  // RÉVISÉE une seconde fois le 2026-08-20, tranche 2 de SPK-45 : `container`
  // et `shell` s'ajoutent (§37.4.7). Ce sont des MÉTADONNÉES, du même genre que
  // `spark` — dans quoi l'on est entré, et avec quoi. Ni l'une ni l'autre ne
  // porte un octet de la session, et la preuve ci-dessous l'éprouve.
  //
  // `shell` vient de la sortie d'une image du locataire, ce qui pourrait
  // rouvrir la fuite : il est borné à un CHEMIN ABSOLU par le sondage, dont
  // `shell-conteneur.test.js` garde la règle. Ici, on éprouve qu'aucun contenu
  // de session n'y arrive.
  assert.deepEqual(Object.keys(session.describe()).sort(),
    ['closed', 'container', 'durationSeconds', 'forge', 'id', 'lastActivity',
     'openedAt', 'path', 'rescueReason', 'reason', 'shell', 'spark', 'state',
     'type'].sort());
  // Et le nouveau champ est BORNÉ : il ne prend que des motifs connus, jamais
  // un texte venu de la session. Sinon il rouvrirait exactement la fuite que ce
  // test existe pour fermer.
  const { session: depannage } = pile({
    tunnel: { jumpArgs: () => [], forgeArgs: () => [] },
    spark: { name: 'crm', ipv4_address: '10.77.0.16', incus_name: 'spark-crm' },
    chemin: CHEMIN_DEPANNAGE, motifDepannage: SSHD_MUET,
  });
  assert.ok([EN_ERREUR, SSHD_MUET].includes(depannage.describe().rescueReason));
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
  const { manager, session, enfant } = pile();
  const vus = [];
  session.abonner((type, data) => vus.push([type, data]));
  enfant.emit('exit', 0);
  assert.equal(session.motif, DISTANT_TERMINE);
  assert.deepEqual(vus.at(-1), ['fin', DISTANT_TERMINE]);
  assert.equal(manager.list().length, 0,
    'une session que le distant a terminée ne reste pas affichée comme vivante');
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

test('le redimensionnement appelle le PTY sans écrire dans le shell', () => {
  const { session, enfant } = pile();
  session.redimensionner(40, 120);
  assert.deepEqual(enfant.redimensionnements, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(enfant.stdin.ecrit, []);
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

test('le DOUBLON remplace la commande lancée, pas le mécanisme', () => {
  // §37.4.2 bis : le harnais y met un interpréteur local ; tout le reste du
  // chemin — flux, saisie, mort du distant — est celui de la production.
  const enfants = [];
  const manager = new SessionManager({
    commande: '/bin/sh -i',
    ptySpawn: (commande, args) => {
      const e = fauxSsh(); e.commande = commande; e.args = args;
      enfants.push(e); return e;
    },
  });
  manager.ouvrir({ tunnel: { jumpArgs: () => [] }, spark: SPARK });
  assert.equal(enfants[0].commande, '/bin/sh');
  assert.deepEqual(enfants[0].args, ['-i']);
});

test('SANS doublon, c’est bien « ssh » qui est lancé', () => {
  const { enfant } = pile();
  assert.equal(enfant.commande, 'ssh');
});

// --- SPK-43, tranche 4 · LE CHEMIN DE DÉPANNAGE (§37.3) ---------------------
//
// Ce chemin donne au plan de contrôle l'exécution arbitraire en root chez le
// locataire, ce que le §11 évite partout ailleurs. Ce qui suit garde ses quatre
// conditions ; sans elles ce serait simplement une seconde façon d'entrer.

const CELLULE = { name: 'crm', ipv4_address: '10.77.0.16', incus_name: 'spark-crm',
                  state: 'running' };
const FORGE_DISTANTE = {
  jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'],
  forgeArgs: () => ['-p', '22', 'ubuntu@203.0.113.10'],
};
const FORGE_LOCALE = { jumpArgs: () => [], forgeArgs: () => [] };

test('le dépannage vise la FORGE et lui fait exécuter incus, pas le Spark', () => {
  const { enfant } = pile({
    tunnel: FORGE_DISTANTE, spark: CELLULE,
    chemin: CHEMIN_DEPANNAGE, motifDepannage: SSHD_MUET,
  });
  assert.equal(enfant.commande, 'ssh');
  // La destination est le SERVEUR, pas l'adresse privée du Spark : c'est la
  // Forge qui commande Incus, et le Spark est justement ce qui ne répond pas.
  assert.ok(enfant.args.includes('ubuntu@203.0.113.10'));
  assert.ok(!enfant.args.some((a) => String(a).includes('10.77.0.16')),
    'le dépannage ne se connecte pas au Spark');
  assert.ok(!enfant.args.includes('-J'), 'la Forge est la destination, pas un rebond');
  // Le port passe par « -p » : « -J » l'accepte collé au nom, « ssh » non.
  assert.deepEqual(enfant.args.slice(-8),
    ['-p', '22', 'ubuntu@203.0.113.10',
     'incus', 'exec', 'spark-crm', '--', '/bin/bash']);
});

test('« -- » est présent : sans lui incus prendrait les options du shell', () => {
  const { enfant } = pile({ tunnel: FORGE_DISTANTE, spark: CELLULE,
                            chemin: CHEMIN_DEPANNAGE });
  const separateur = enfant.args.indexOf('--');
  assert.ok(separateur > 0, 'le séparateur existe');
  assert.equal(enfant.args[separateur - 1], 'spark-crm',
    'il suit immédiatement le nom de la cellule');
});

test('sur une Forge LOCALE, le dépannage n’ouvre aucun ssh', () => {
  // Incus est ici : passer par `ssh` vers soi-même ajouterait une dépendance à
  // un `sshd` local que rien n'exige (§28.2).
  const { enfant } = pile({ tunnel: FORGE_LOCALE, spark: CELLULE,
                            chemin: CHEMIN_DEPANNAGE });
  assert.equal(enfant.commande, 'incus');
  assert.deepEqual(enfant.args, ['exec', 'spark-crm', '--', '/bin/bash']);
});

test('le chemin emprunté est rendu par la session, et il ne change plus', () => {
  // §37.3 : « la bannière reste visible pendant toute la session ». L'écran ne
  // peut la tenir que si la session dit son chemin RÉEL, à l'ouverture comme à
  // la fermeture — un « ssh » écrit en dur mentirait sur les deux.
  const { session } = pile({ tunnel: FORGE_DISTANTE, spark: CELLULE,
                             chemin: CHEMIN_DEPANNAGE, motifDepannage: EN_ERREUR });
  assert.equal(session.describe().path, CHEMIN_DEPANNAGE);
  assert.equal(session.describe().rescueReason, EN_ERREUR);
  session.fermer(SORTIE);
  assert.equal(session.describe().path, CHEMIN_DEPANNAGE,
    'le chemin survit à la fermeture : le journal le reçoit là aussi');
});

test('une session normale reste « ssh », et ne porte AUCUN motif de dépannage', () => {
  const { session } = pile({ tunnel: FORGE_DISTANTE, spark: CELLULE });
  assert.equal(session.describe().path, CHEMIN_SSH);
  assert.equal(session.describe().rescueReason, null);
});

test('un motif de dépannage posé sur une session NORMALE est écarté', () => {
  // Sinon le journal porterait « ouvert pour sshd muet » sur une session SSH
  // parfaitement ordinaire, et le relevé du §37.3 deviendrait faux.
  const { session } = pile({ tunnel: FORGE_DISTANTE, spark: CELLULE,
                             chemin: CHEMIN_SSH, motifDepannage: SSHD_MUET });
  assert.equal(session.describe().rescueReason, null);
});

test('un chemin inconnu est REFUSÉ à la construction', () => {
  assert.throws(
    () => new Session({ tunnel: FORGE_DISTANTE, spark: CELLULE, chemin: 'root' }),
    TerminalError);
});

// --- La règle d'ouverture, appliquée côté hôte console (CLAUDE.md §10) ------

test('le dépannage s’ouvre sur un Spark EN ERREUR, sans même sonder', () => {
  const verdict = depannageOuvert({ ...CELLULE, state: 'error' });
  assert.equal(verdict.ouvert, true);
  assert.equal(verdict.motif, EN_ERREUR);
});

test('le dépannage s’ouvre quand RIEN ne répond sur le port 22', () => {
  const verdict = depannageOuvert(CELLULE, classerEchecSsh(255, 'ssh: connect to host 10.77.0.16 port 22: Connection refused'));
  assert.equal(verdict.ouvert, true);
  assert.equal(verdict.motif, SSHD_MUET);
});

test('une clé REFUSÉE n’ouvre PAS le dépannage, et l’écran dit quoi faire', () => {
  // Le point qui décide du §37.3 : « le sshd ne répond pas » et « le sshd
  // répond et refuse la clé » ne sont pas le même incident. Le second se règle
  // en réaccordant l'accès, pas en employant un pouvoir d'exception.
  const verdict = depannageOuvert(CELLULE,
    classerEchecSsh(255, 'root@10.77.0.16: Permission denied (publickey).'));
  assert.equal(verdict.ouvert, false);
  assert.equal(verdict.motif, 'cle_refusee');
  assert.match(verdict.explication, /onglet Clés/);
});

test("une clé d’hôte CHANGÉE est nommée et n’ouvre pas le dépannage", () => {
  const sondage = classerEchecSsh(255,
    'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key has changed');
  assert.deepEqual(sondage, { repond: true, motif: CLE_HOTE_CHANGEE });
  const verdict = depannageOuvert(CELLULE, sondage);
  assert.equal(verdict.ouvert, false);
  assert.equal(verdict.motif, CLE_HOTE_CHANGEE);
  assert.match(verdict.explication, /ne l.accepte ni ne l.efface/i);
});

test('un échec NON RECONNU n’ouvre pas le dépannage', () => {
  // Ouvrir sur un doute reviendrait à ouvrir toujours : toute panne finit par
  // produire un message que l'on ne reconnaît pas.
  const verdict = depannageOuvert(CELLULE, classerEchecSsh(255, 'kex_exchange_identification: banner'));
  assert.equal(verdict.ouvert, false);
});

test('un Spark JOIGNABLE ne donne pas accès au dépannage', () => {
  const verdict = depannageOuvert(CELLULE, classerEchecSsh(0, ''));
  assert.equal(verdict.ouvert, false);
  assert.equal(verdict.motif, 'ssh_disponible');
});

test('un Spark SANS CELLULE ne donne pas accès au dépannage', () => {
  // `incus exec` échouerait sur un nom qui n'existe pas ; le refus le dit.
  const verdict = depannageOuvert({ name: 'analytics', state: 'pending' });
  assert.equal(verdict.ouvert, false);
  assert.equal(verdict.motif, 'sans_cellule');
});

test('le sondage emprunte le MÊME chemin que le terminal normal', async () => {
  let vu = null;
  const faux = (commande, args) => {
    vu = { commande, args };
    const e = fauxSsh();
    setImmediate(() => { e.stderr.emit('data', Buffer.from('Connection refused')); e.emit('exit', 255); });
    return e;
  };
  const verdict = await sonderSshd({ tunnel: FORGE_DISTANTE, spark: CELLULE, spawn: faux });
  assert.equal(vu.commande, 'ssh');
  assert.ok(vu.args.includes('-J'), 'le sondage passe par le même rebond');
  assert.ok(vu.args.includes('root@10.77.0.16'));
  assert.equal(vu.args.at(-1), 'true', 'le sondage n’exécute rien d’autre');
  assert.equal(verdict.repond, false);
  assert.equal(verdict.motif, SSHD_MUET);
});

test('un ssh INTROUVABLE ne fait pas conclure que le sshd est muet', async () => {
  // Sinon le dépannage s'ouvrirait parce que la CONSOLE est mal installée.
  const faux = () => {
    const e = fauxSsh();
    setImmediate(() => e.emit('error', new Error('spawn ssh ENOENT')));
    return e;
  };
  const verdict = await sonderSshd({ tunnel: FORGE_DISTANTE, spark: CELLULE, spawn: faux });
  assert.equal(verdict.repond, true);
  assert.equal(depannageOuvert(CELLULE, verdict).ouvert, false);
});

// --- Le doublon du transport, résolu par Spark (§37.4.2 bis) ----------------

test('une commande SIMPLE vaut pour tous les Sparks, comme avant', () => {
  assert.equal(commandePour('cat', { name: 'crm' }), 'cat');
  assert.equal(commandePour('cat', { name: 'autre' }), 'cat');
});

test('absente, le produit lance ssh — le doublon ne s’invente pas', () => {
  assert.equal(commandePour(null, { name: 'crm' }), null);
  assert.equal(commandePour('', { name: 'crm' }), null);
});

test('une TABLE choisit par Spark, et « * » couvre le reste', () => {
  // Un doublon qui ne sait représenter qu'un distant VIVANT ne peut pas
  // éprouver ce qui arrive quand il meurt — le cas même du sshd muet.
  const table = '{"*":"cat","site-vitrine":"false"}';
  assert.equal(commandePour(table, { name: 'site-vitrine' }), 'false');
  assert.equal(commandePour(table, { name: 'crm' }), 'cat');
});

test('une table SANS « * » ne double PAS les autres Sparks', () => {
  // Rendre `cat` par défaut ferait taire une table incomplète ; rendre `null`
  // fait lancer `ssh`, ce qui se voit tout de suite.
  assert.equal(commandePour('{"site-vitrine":"false"}', { name: 'crm' }), null);
});

test('une table ILLISIBLE est refusée, pas ignorée', () => {
  // L'ignorer reviendrait à lancer un vrai `ssh` depuis un harnais, contre une
  // adresse privée qui n'existe pas — un échec lent et trompeur.
  assert.throws(() => commandePour('{ceci n’est pas du JSON', { name: 'crm' }),
                TerminalError);
});

test('le gestionnaire résout la commande POUR CE Spark', () => {
  const { enfant } = pile({
    commande: '{"*":"cat","site-vitrine":"false"}',
    tunnel: FORGE_DISTANTE,
    spark: { name: 'site-vitrine', ipv4_address: '10.77.0.19', incus_name: 'site-vitrine' },
  });
  assert.equal(enfant.commande, 'false');
});

test('une entrée peut distinguer les deux CHEMINS d’un même Spark', () => {
  // Sur un Spark au `sshd` muet, le chemin normal meurt et le dépannage
  // fonctionne : c'est toute la raison d'être du §37.3. Un doublon qui les
  // traiterait pareil rendrait le dépannage inéprouvable là où il sert.
  const table = '{"*":"cat","site-vitrine":{"ssh":"false","rescue":"cat"}}';
  assert.equal(commandePour(table, { name: 'site-vitrine' }, CHEMIN_SSH), 'false');
  assert.equal(commandePour(table, { name: 'site-vitrine' }, CHEMIN_DEPANNAGE), 'cat');
  assert.equal(commandePour(table, { name: 'crm' }, CHEMIN_DEPANNAGE), 'cat');
});

test('une entrée par chemin INCOMPLÈTE retombe sur celle du chemin normal', () => {
  assert.equal(commandePour('{"crm":{"ssh":"cat"}}', { name: 'crm' }, CHEMIN_DEPANNAGE),
               'cat');
});

// --- SPK-45 · LE TERMINAL DANS UN CONTENEUR (§37.4.7) ----------------------

test('un terminal de conteneur ajoute UN CRAN au chemin du §37.2', () => {
  // Ce n'est pas un second mécanisme : c'est le même `ssh` vers le Spark, suivi
  // de `docker exec -it`, dans le contexte rootless réellement utilisable.
  // Dupliquer le transport ferait diverger deux terminaux.
  const { session, enfant } = pile({
    chemin: 'container', conteneur: 'crm-web-1', shell: '/bin/bash' });
  assert.equal(enfant.commande, 'ssh');
  assert.ok(enfant.args.includes('-tt'), 'le pseudo-terminal vient du Spark');
  assert.ok(enfant.args.includes('root@10.77.0.16'));
  const fin = enfant.args.at(-1);
  assert.match(fin, /^sh -lc /);
  assert.match(fin, /docker info/, 'le socket rootless est sondé');
  assert.match(fin, /docker exec -it/);
  assert.match(fin, /crm-web-1/);
  assert.match(fin, /\/bin\/bash/);
  session.fermer('sortie');
});

test('la session DIT dans quoi elle est entrée, et avec quel shell', () => {
  // Sans cela, l'écran ne distinguerait pas un shell du Spark d'un shell de
  // conteneur, et sa bannière mentirait sur ce qu'on est en train de piloter.
  const { session } = pile({ chemin: 'container', conteneur: 'crm-base-1',
                             shell: '/bin/sh' });
  const vu = session.describe();
  assert.equal(vu.path, 'container');
  assert.equal(vu.container, 'crm-base-1');
  assert.equal(vu.shell, '/bin/sh');
  session.fermer('sortie');
});

test('une session de SPARK ne porte ni conteneur ni shell', () => {
  // §14.6 : rendre une chaîne vide ferait lire « un conteneur sans nom ».
  const { session } = pile();
  assert.equal(session.describe().container, null);
  assert.equal(session.describe().shell, null);
  session.fermer('sortie');
});

test('on n’entre PAS dans un conteneur sans shell sondé', () => {
  // §37.4.7 : ouvrir sans lui reviendrait à supposer ce que le sondage existe
  // pour établir, et l'échec n'arriverait qu'après, sans dire pourquoi.
  for (const manquant of [{ conteneur: 'web' }, { shell: '/bin/sh' }, {}]) {
    assert.throws(() => pile({ chemin: 'container', ...manquant }),
                  /conteneur ET son shell/, JSON.stringify(manquant));
  }
});

test('un chemin d’entrée INVENTÉ est refusé', () => {
  assert.throws(() => pile({ chemin: 'docker' }), /Chemin d'entrée inconnu/);
});
