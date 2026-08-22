import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSessionRegistry } from './session-registry.js';

const SESSION = {
  id: 'opaque-42', forge: 'production', spark: 'crm', path: 'container',
  type: 'container', container: 'nginx', openedAt: '2026-08-22T10:00:00.000Z',
  lastActivity: '2026-08-22T10:01:00.000Z', state: 'open',
};

test('le registre nomme une session et ne reçoit aucun contenu de terminal', () => {
  const rendu = renderSessionRegistry({ sessions: [SESSION] });
  assert.match(rendu, /Conteneur · crm \/ nginx/);
  assert.match(rendu, /Forge : production/);
  assert.match(rendu, /data-session-select="opaque-42"/);
  assert.ok(!rendu.includes('SECRET-EN-CLAIR'));
});

test('la fermeture demande une confirmation qui dit que le shell sera tué', () => {
  const rendu = renderSessionRegistry({ sessions: [SESSION], confirmation: SESSION.id });
  assert.match(rendu, /shell distant sera tué/);
  assert.match(rendu, /data-session-close-confirm="opaque-42"/);
  assert.match(rendu, /data-session-close-cancel/);
});

test('un registre vide ne simule aucune session passée', () => {
  assert.match(renderSessionRegistry(), /Aucune session ouverte/);
});
