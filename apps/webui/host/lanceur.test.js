/**
 * @verifies docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.1 (un lanceur, parce qu'un
 *           processus ne se relance pas lui-même)
 *
 * Les preuves du superviseur lancent de VRAIS processus Node : le contrat tient
 * dans l'ordre des messages IPC et des sorties, et un faux `spawn` prouverait
 * seulement qu'il a été écrit comme le test l'attend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { superviser, canalEnfant, DEMANDE, PRESENTATION, RELANCE } from './lanceur.js';

const LANCEUR = new URL('./lanceur.js', import.meta.url).href;

/** Un enfant qui parle le protocole comme `main.js`, et compte ses vies. */
function enfantScript(compteur, corps) {
  return `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { canalEnfant } from ${JSON.stringify(LANCEUR)};
    appendFileSync(${JSON.stringify(compteur)}, 'x');
    const vie = readFileSync(${JSON.stringify(compteur)}, 'utf8').length;
    const canal = canalEnfant();
    ${corps}
  `;
}

async function avecDossier(agir) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-lanceur-'));
  try { return await agir(dossier); } finally {
    await rm(dossier, { recursive: true, force: true });
  }
}

/** Un `process` de substitution : il reçoit les signaux que le test lui envoie. */
function processusFactice() {
  const p = new EventEmitter();
  p.execPath = process.execPath;
  return p;
}

test('un enfant qui annonce sa relance est relancé, avec le code relu sur le disque', async () => {
  await avecDossier(async (dossier) => {
    const compteur = join(dossier, 'vies');
    const script = join(dossier, 'enfant.mjs');
    await writeFile(compteur, '');
    // Première vie : attend la présentation, annonce, sort. Seconde vie : sort
    // en 7, sans rien annoncer — le lanceur doit alors s'arrêter avec elle.
    await writeFile(script, enfantScript(compteur, `
      if (vie === 1) {
        process.on('message', async (m) => {
          if (m?.type === ${JSON.stringify(PRESENTATION)} && canal.relancable) {
            await canal.relancer(async () => {});
          }
        });
        canal.saluer();
      } else {
        process.exit(7);
      }
    `));
    const lignes = [];
    const code = await superviser({ script, processus: processusFactice(),
                                    journal: (l) => lignes.push(l) });
    assert.equal(code, 7, 'le code de la seconde vie devient celui du lanceur');
    assert.equal((await readFile(compteur, 'utf8')).length, 2, 'deux vies, pas une de plus');
    assert.match(lignes.join('\n'), /console relancée/);
  });
});

test('une panne n’est jamais relancée : le lanceur sort avec le code de l’enfant', async () => {
  await avecDossier(async (dossier) => {
    const compteur = join(dossier, 'vies');
    const script = join(dossier, 'enfant.mjs');
    await writeFile(compteur, '');
    await writeFile(script, enfantScript(compteur, 'process.exit(3);'));
    const code = await superviser({ script, processus: processusFactice(), journal: () => {} });
    assert.equal(code, 3);
    assert.equal((await readFile(compteur, 'utf8')).length, 1);
  });
});

test('un signal reçu est transmis à l’enfant, et rien n’est relancé même annoncé', async () => {
  await avecDossier(async (dossier) => {
    const compteur = join(dossier, 'vies');
    const script = join(dossier, 'enfant.mjs');
    await writeFile(compteur, '');
    // L'enfant annonce sa relance dès sa naissance, puis attend : seul le
    // signal le fera sortir. Un lanceur qui relancerait sur l'annonce seule
    // prendrait `sparkui stop` pour une demande de redémarrage.
    await writeFile(script, enfantScript(compteur, `
      process.send({ type: ${JSON.stringify(RELANCE)} });
      process.send({ type: 'pret' });
      setInterval(() => {}, 1000);
    `));
    const processus = processusFactice();
    const lanceur = superviser({ script, processus, journal: () => {},
      spawnFn: (...args) => {
        const enfant = spawn(...args);
        enfant.on('message', (m) => { if (m?.type === 'pret') processus.emit('SIGTERM'); });
        return enfant;
      } });
    assert.equal(await lanceur, 128 + 15, 'tué par SIGTERM, comme un shell le dirait');
    assert.equal((await readFile(compteur, 'utf8')).length, 1);
    assert.equal(processus.listenerCount('SIGTERM'), 0, 'le lanceur rend les signaux en sortant');
  });
});

test('un enfant sans lanceur ne se croit pas relançable', async () => {
  const canal = canalEnfant({ on() {} });
  assert.equal(canal.relancable, false);
  await assert.rejects(canal.relancer(async () => {}), /aucun lanceur/);
});

test('un canal IPC seul ne suffit pas : il faut la présentation du lanceur', () => {
  const p = new EventEmitter();
  const envoyes = [];
  p.send = (m, ok) => { envoyes.push(m); ok?.(); };
  const canal = canalEnfant(p);
  assert.equal(canal.relancable, false, 'un canal que personne n’écoute n’est pas un lanceur');
  canal.saluer();
  assert.deepEqual(envoyes, [{ type: DEMANDE }]);
  p.emit('message', { type: 'autre-chose' });
  assert.equal(canal.relancable, false);
  p.emit('message', { type: PRESENTATION });
  assert.equal(canal.relancable, true);
});

test('la relance est annoncée AVANT la fermeture, et la sortie vient après', async () => {
  const p = new EventEmitter();
  const ordre = [];
  p.send = (m, ok) => { ordre.push(m.type); setImmediate(ok); };
  p.exit = (code) => ordre.push(`exit ${code}`);
  const canal = canalEnfant(p);
  p.emit('message', { type: PRESENTATION });
  await canal.relancer(async () => { ordre.push('fermer'); });
  assert.deepEqual(ordre, [RELANCE, 'fermer', 'exit 0']);
});

test('la perte du lanceur est signalée à l’enfant', () => {
  const p = new EventEmitter();
  p.send = () => {};
  let perdu = false;
  canalEnfant(p).surPerte(() => { perdu = true; });
  p.emit('disconnect');
  assert.equal(perdu, true);
});
