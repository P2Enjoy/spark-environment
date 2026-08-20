/**
 * @verifies docs/BACKLOG.md#SPK-46 · docs/DAT.md §21.5 bis (le vocabulaire du
 *           journal, et qui le traduit) · docs/DESIGN_SYSTEM.md §14.7
 * @verifies docs/DESIGN_SYSTEM.md §2.6, §12.5, §14.6, §14.7 ·
 *           docs/DESIGN_SYSTEM_APP.md §4
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPARK_STATES, stateOf, formatBytes, formatBps, formatCpu, MEASURE,
  TUNNEL_STATES, tunnelOf, traduireMessage, formatOctetsExact,
  SIGNATURE_MOTIFS, signatureMotifOf,
} from './tokens.js';
// La table de l'hôte console est la RÉFÉRENCE des jetons : on l'importe plutôt
// que d'en recopier la liste, sans quoi la garde ci-dessous garderait une copie.
import { MOTIFS, SANS_CLE, AGENT_MUET } from '../../host/signature.js';

test('les huit etats du modele sont couverts', () => {
  // docs/SCHEMA.md §4 : un etat non couvert tomberait dans le repli sans qu'on
  // s'en apercoive.
  for (const etat of ['pending', 'creating', 'stopped', 'starting', 'running',
                      'stopping', 'error', 'deleting']) {
    assert.ok(SPARK_STATES[etat], `${etat} doit avoir une correspondance`);
  }
});

test('les etats transitoires sont marques comme tels', () => {
  for (const etat of ['creating', 'starting', 'stopping', 'deleting'])
    assert.equal(SPARK_STATES[etat].transient, true);
  for (const etat of ['running', 'stopped', 'pending', 'error'])
    assert.equal(SPARK_STATES[etat].transient, false);
});

test('une valeur inconnue recoit un repli, jamais undefined', () => {
  // docs/DESIGN_SYSTEM.md §14.7
  const inconnu = stateOf('zombie');
  assert.equal(inconnu.token, 'neutral');
  assert.match(inconnu.label, /inconnu/);
  assert.ok(!inconnu.label.includes('undefined'));
  assert.match(stateOf(undefined).label, /inconnu/);
});

test('null n est jamais formate en zero', () => {
  // docs/DESIGN_SYSTEM.md §14.6 — zero et « on ne sait pas » sont distincts.
  assert.equal(formatBytes(null), null);
  assert.equal(formatBps(null), null);
  assert.equal(formatCpu(null), null);
  assert.equal(formatBytes(0), '0 o');
  assert.equal(formatCpu(0), '0,00');
});

test('les octets sont lisibles', () => {
  assert.equal(formatBytes(2 * 1024 ** 3), '2,0 Gio');
  assert.equal(formatBytes(534981632), '510 Mio');
});

test('les debits sont lisibles', () => {
  assert.equal(formatBps(100_000_000), '100 Mbit/s');
  assert.equal(formatBps(1_000_000_000), '1,0 Gbit/s');
});

test('le separateur decimal est la virgule, pas le point', () => {
  // Le produit est entierement francophone : « 2.0 Gio » est un anglicisme.
  assert.equal(formatCpu(1.996), '2,00');
  assert.equal(formatCpu(0.5), '0,50');
  assert.ok(!formatBytes(2 * 1024 ** 3).includes('.'));
});

test('la precision du CPU est fixe', () => {
  // « 2.0 sur 0.50 » juxtaposait deux precisions dans une meme phrase.
  assert.equal(formatCpu(2).length, formatCpu(0.5).length);
});

test('les trois absences de mesure ont des textes distincts', () => {
  const textes = Object.values(MEASURE);
  assert.equal(new Set(textes).size, textes.length);
  for (const t of textes) assert.ok(t.length > 0);
});

// --- un Spark declare n'est pas un Spark en cours de mesure (§14.6) ---------

test('les quatre absences de mesure portent des textes DISTINCTS', () => {
  const textes = Object.values(MEASURE);
  assert.equal(new Set(textes).size, textes.length,
    'confondre deux situations les rendrait indiscernables a l’ecran');
  assert.match(MEASURE.declared, /rien à mesurer/);
});

// --- le vocabulaire du tunnel est defini une seule fois (§14.7) -------------

test('les etats de tunnel portent des libelles francais distincts', () => {
  const labels = Object.values(TUNNEL_STATES).map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every((l) => !/^[a-z]+$/.test(l) || !['ready','broken','closed'].includes(l)));
  assert.equal(tunnelOf('broken').label, 'rompu');
  assert.equal(tunnelOf('ready').label, 'ouvert');
});

test('un etat de tunnel inconnu ne casse rien et reste visible', () => {
  assert.equal(tunnelOf('quelque-chose').label, 'quelque-chose');
  assert.equal(tunnelOf(undefined).label, 'inconnu');
});

// --- la traduction des messages (SPK-46, docs/DAT.md §21.5 bis) ------------

test('une transition d’etats est traduite dans le vocabulaire de l’ecran', () => {
  // Le meme concept portait deux vocabulaires a quelques centimetres d'ecart :
  // le badge disait « En marche », le journal « running » (INC-01).
  assert.equal(traduireMessage('« starting » → « running ».'),
               '« Démarrage… » → « En marche ».');
  assert.equal(traduireMessage('« stopped » → « starting ».'),
               '« Arrêté » → « Démarrage… ».');
  assert.equal(traduireMessage('« pending » → « creating ».'),
               '« En attente » → « Création… ».');
});

test('un etat de TUNNEL cite par l’hote console est traduit aussi', () => {
  // Le registre signalait ce message comme le MEME ecart : le badge disait
  // « rompu » quand le texte disait « broken » (§22.3).
  assert.equal(
    traduireMessage('Tunnel vers « validation » indisponible (broken, jamais joint).'),
    'Tunnel vers « validation » indisponible (rompu, jamais joint).');
});

test('un NOM cite qui n’est pas un etat traverse INTACT', () => {
  // C'est la garantie centrale : la console ne DEVINE pas. « validation » est un
  // nom de serveur, pas un etat, et le traduire serait le deformer.
  assert.ok(traduireMessage('Tunnel vers « validation » indisponible.')
              .includes('« validation »'));
  assert.equal(traduireMessage('Spark « boutique » supprimé.'),
               'Spark « boutique » supprimé.');
});

test('un message que la console ne reconnait PAS traverse mot pour mot', () => {
  // Un message inconnu mal traduit serait pire que le meme message reste
  // technique (§21.5 bis).
  for (const brut of [
    'Relevé appliqué. MemTotal 94 Gio, ARC 8 Gio.',
    'Capacité relevée inférieure à l’allocation en cours : memory.',
    '4 route(s) appliquée(s).',
    'Le port 443 est tenu par le proxy.',
  ]) assert.equal(traduireMessage(brut), brut);
});

test('seul l’etat CONNU d’un message mixte est traduit', () => {
  // « zombie » n'est pas un etat du produit : il reste tel quel, et seul
  // « running » est traduit. La traduction est mot a mot, pas globale.
  assert.equal(traduireMessage('« zombie » → « running ».'),
               '« zombie » → « En marche ».');
});

test('une valeur absente ne devient jamais « undefined » a l’ecran', () => {
  // §14.7 : une valeur inconnue recue du backend ne doit pas atteindre l'ecran
  // sous cette forme.
  assert.equal(traduireMessage(null), '');
  assert.equal(traduireMessage(undefined), '');
  assert.equal(traduireMessage(''), '');
});

// --- lire une mesure n'est pas regler un quota (SPK-59, §6.9 bis) -----------

test('le format EXACT rend le pas de 256 Mio, la ou l arrondi le masque', () => {
  const GIO = 1024 ** 3;
  // Trois crans sur quatre disparaissent avec le format des mesures.
  assert.equal(formatOctetsExact(1.25 * GIO), '1,25 Gio');
  assert.equal(formatBytes(1.25 * GIO), '1,3 Gio');
  assert.equal(formatOctetsExact(10.25 * GIO), '10,25 Gio');
  assert.equal(formatBytes(10.25 * GIO), '10 Gio');
});

test('le format exact ne traine pas de zeros inutiles', () => {
  const GIO = 1024 ** 3;
  assert.equal(formatOctetsExact(2 * GIO), '2 Gio');
  assert.equal(formatOctetsExact(2.5 * GIO), '2,5 Gio');
  assert.equal(formatOctetsExact(76 * GIO), '76 Gio');
});

test('il descend dans l unite qui dit la valeur sans decimale', () => {
  const MIO = 1024 ** 2;
  assert.equal(formatOctetsExact(256 * MIO), '256 Mio');
  assert.equal(formatOctetsExact(512 * MIO), '512 Mio');
  assert.equal(formatOctetsExact(768 * MIO), '768 Mio');
});

test('la virgule francaise est employee, et null reste null', () => {
  assert.ok(!formatOctetsExact(1.25 * 1024 ** 3).includes('.'));
  assert.equal(formatOctetsExact(null), null);
  assert.equal(formatOctetsExact(undefined), null);
});

/* --- Ce qui est parti sans signature (SPK-40, §36.10.9) ------------------- */

test('la console a une phrase pour CHAQUE motif de l hote, et pas une de plus', () => {
  // Un motif sans phrase serait un echec TU, ce que le §36.10.8 interdit ; une
  // phrase sans motif serait du texte que rien ne peut declencher (§1.4).
  assert.deepEqual(Object.keys(SIGNATURE_MOTIFS).sort(), [...MOTIFS].sort());
});

test('chaque phrase dit que le geste a EU LIEU', () => {
  // §36.10.1 : le geste passe. Une phrase qui laisserait croire au contraire
  // ferait refaire un arret, un demarrage ou une suppression deja accomplis.
  for (const [jeton, phrase] of Object.entries(SIGNATURE_MOTIFS)) {
    assert.match(phrase, /a bien eu lieu/, jeton);
  }
});

test('le motif de l agent muet dit quoi FAIRE, sans le message d OpenSSH', () => {
  // §14.7 : « Load key … No such file » nomme un fichier que l exploitant n a
  // pas demande. Ce qui manque vraiment, c est la cle dans l agent.
  assert.match(SIGNATURE_MOTIFS[AGENT_MUET], /ssh-add/);
  assert.ok(!/No such file/.test(SIGNATURE_MOTIFS[AGENT_MUET]));
});

test('aucune phrase ne laisse passer le jeton technique', () => {
  // §14.7 : « sans_cle » a l ecran ne veut rien dire pour un exploitant.
  for (const jeton of MOTIFS) {
    assert.ok(!signatureMotifOf(jeton).includes(jeton), jeton);
  }
});

test('un motif INCONNU se dit quand meme, et rien ne se dit sans motif', () => {
  // §2.6 : le repli est documente. Taire un motif inconnu ferait disparaitre
  // l avertissement au moment ou l on sait le moins ce qui s est passe.
  assert.match(signatureMotifOf('venu_d_ailleurs'), /a bien eu lieu/);
  assert.equal(signatureMotifOf(null), null);
  assert.equal(signatureMotifOf(''), null);
  assert.match(signatureMotifOf(SANS_CLE), /clé de signature/);
});
