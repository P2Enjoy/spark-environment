/**
 * @verifies docs/BACKLOG.md#SPK-106 · docs/DAT.md §29.8 (une seule pile lourde
 * à la fois) · CLAUDE.md §14, §21
 *
 * Ces preuves ne montent AUCUNE pile : c'est le point. Le verrou doit être
 * éprouvable sans payer ce qu'il existe pour empêcher, sans quoi la seule façon
 * de le vérifier serait de saturer la machine.
 *
 * Ce qu'elles gardent :
 *
 * - une seconde prise est REFUSÉE, et le refus nomme qui tient ;
 * - un verrou dont le porteur est MORT est repris — un OOM ne doit pas rendre
 *   le harnais inutilisable jusqu'à ce que quelqu'un efface un fichier dont il
 *   ignore l'existence ;
 * - la sortie normale le rend, y compris sur exception.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHEMIN, VerrouTenu, prendreLeVerrou, rendreLeVerrou } from './verrou.mjs';

const ICI = dirname(fileURLToPath(import.meta.url));

/** Un processus tiers qui prend le verrou et rend la main, ou échoue. */
function dansUnAutreProcessus(script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script],
                      { cwd: ICI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test.beforeEach(() => { rendreLeVerrou(); rmSync(CHEMIN, { force: true }); });
test.afterEach(() => { rendreLeVerrou(); rmSync(CHEMIN, { force: true }); });

test('la première prise réussit et laisse une trace nommant le porteur', () => {
  prendreLeVerrou();
  assert.ok(existsSync(CHEMIN), 'le verrou doit exister sur le disque');
  const porteur = JSON.parse(execFileSync('cat', [CHEMIN], { encoding: 'utf8' }));
  assert.equal(porteur.pid, process.pid);
  assert.ok(porteur.depuis, 'la date de prise est inscrite : le refus la montre');
});

test('une SECONDE prise, par un autre processus, est REFUSÉE', () => {
  prendreLeVerrou();
  // Le second processus est réel : deux appels dans le même processus ne
  // prouveraient rien, puisqu'ils partagent la même variable en mémoire.
  const sortie = dansUnAutreProcessus(`
    import { prendreLeVerrou } from './verrou.mjs';
    try { prendreLeVerrou(); console.log('PRIS'); }
    catch (e) { console.log('REFUSE:' + e.name + ':' + e.porteur.pid); }
  `).trim();
  assert.equal(sortie, `REFUSE:VerrouTenu:${process.pid}`,
    'le refus doit NOMMER le processus qui tient');
  assert.ok(existsSync(CHEMIN), 'un refus ne doit pas emporter le verrou d’autrui');
});

test('le refus DIT quoi faire, et ne parle pas d’un réglage qui n’existe pas', () => {
  prendreLeVerrou();
  const erreur = new VerrouTenu(
    { pid: 4242, commande: 'e2e/parcours.test.mjs', depuis: new Date().toISOString() });
  assert.match(erreur.message, /DÉJÀ/);
  assert.match(erreur.message, /4242/);
  assert.match(erreur.message, /e2e\/parcours\.test\.mjs/);
  assert.match(erreur.message, /Attendez qu’elle finisse/);
  // CLAUDE.md §3 : aucun interrupteur n'existe, donc le message n'en promet
  // aucun. Un refus qui suggère un contournement en apprend un.
  assert.doesNotMatch(erreur.message, /SPARK_[A-Z_]+|--force|désactiv/i);
});

test('un verrou dont le PORTEUR EST MORT est repris', () => {
  // Une épave : le noyau a tué le porteur (OOM, `SIGKILL`), aucun nettoyage
  // n'a pu s'exécuter. Sans reprise, un seul incident rendrait le harnais
  // inutilisable jusqu'à ce que quelqu'un efface ce fichier à la main.
  writeFileSync(CHEMIN, JSON.stringify(
    { pid: 2 ** 22, commande: 'campagne tuée par l’OOM', depuis: '2026-09-14T00:00:00Z' }));
  const avertis = [];
  prendreLeVerrou({ journal: { warn: (m) => avertis.push(m) } });
  assert.equal(avertis.length, 1, 'la reprise se DIT : elle n’est pas silencieuse');
  assert.match(avertis[0], /abandonné/);
  assert.equal(JSON.parse(execFileSync('cat', [CHEMIN], { encoding: 'utf8' })).pid,
               process.pid);
});

test('un verrou ILLISIBLE n’est pas pris pour une épave', () => {
  // Écriture interrompue, fichier tronqué : on ne SAIT pas si quelqu'un tient.
  // Le §29.8 veut qu'on refuse plutôt qu'on devine — reprendre à tort ferait
  // exactement ce que le verrou existe pour empêcher.
  writeFileSync(CHEMIN, '{ ceci n’est pas du JSON');
  assert.throws(() => prendreLeVerrou({ journal: { warn() {} } }), VerrouTenu);
  assert.ok(existsSync(CHEMIN));
});

test('la sortie du processus REND le verrou, même sur exception', () => {
  const script = join(ICI, 'verrou.mjs');
  assert.throws(() => execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import { prendreLeVerrou } from '${script}';
     prendreLeVerrou();
     throw new Error('le harnais a échoué');`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(!existsSync(CHEMIN),
    'un harnais qui échoue ne doit pas laisser le poste verrouillé');
});

test('le rendre deux fois ne lève pas', () => {
  prendreLeVerrou();
  rendreLeVerrou();
  assert.doesNotThrow(() => rendreLeVerrou());
  assert.ok(!existsSync(CHEMIN));
});

test('un porteur MORT dont la pile survit est REFUSÉ, et le refus nomme les survivants', async () => {
  /** @verifies docs/DAT.md §29.8 (complété le 2026-09-17) · CLAUDE.md §15 bis
   *
   * Le cas du 2026-09-17 : un harnais tué en 137 laisse ses Chromium vivants ;
   * reprendre l'épave faisait démarrer une seconde pile à côté d'eux. */
  const { spawn } = await import('node:child_process');
  // Un « porteur » dans SA PROPRE session, qui lance un survivant puis meurt.
  const porteur = spawn(process.execPath, ['-e',
    `const { spawn } = require('node:child_process');
     spawn('sleep', ['30'], { stdio: 'ignore' });
     setInterval(() => {}, 1000);`], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  const sid = porteur.pid; // `detached` = setsid : le porteur est chef de session
  process.kill(porteur.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(CHEMIN, JSON.stringify({ pid: porteur.pid, sid,
    commande: 'node --test parcours', depuis: new Date().toISOString() }));
  try {
    assert.throws(() => prendreLeVerrou({ journal: { warn() {} } }), (e) => {
      assert.equal(e.name, 'VerrouTenu');
      assert.ok(e.survivants.length >= 1, 'le sleep orphelin doit être vu');
      assert.match(e.message, /Tuez-les d’abord/);
      assert.match(e.message, /kill -9 /);
      return true;
    });
    assert.ok(existsSync(CHEMIN), 'le verrou n’est PAS repris tant que la pile survit');
  } finally {
    for (const s of (await import('./verrou.mjs')).survivantsDeLaSession(sid)) {
      try { process.kill(s.pid, 'SIGKILL'); } catch {}
    }
    rmSync(CHEMIN, { force: true });
  }
});
