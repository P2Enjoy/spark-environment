/** @verifies docs/BACKLOG.md#SPK-65 · docs/DAT.md §40.5 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';

test('la build de console périmée est signalée sans tunnel', async () => {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-console-route-'));
  const { server } = createConsoleHost({
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    consoleBuild: { kind: 'git', head: 'avant' },
    consoleRoot: '/arbre-servi',
    compareConsole: () => ({ verdict: 'perimee', behind: 2 }),
  });
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/console/build`);
    assert.equal(r.status, 200);
    const corps = await r.json();
    assert.equal(corps.verdict, 'perimee');
    assert.match(corps.detail, /2 commits · redémarrer pour en bénéficier/);
  } finally {
    await new Promise((ok) => server.close(ok));
    await rm(dossier, { recursive: true, force: true });
  }
});
