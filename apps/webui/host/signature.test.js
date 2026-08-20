/**
 * @verifies docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.3, §36.10.1 (ce que l'unité
 *           n'est PAS), §36.10.3 (la forme canonique), §36.10.7 (les en-têtes),
 *           §36.10.8 (côté console, mesuré) · docs/DESIGN_SYSTEM.md §14.7
 *
 * Ce que ces preuves gardent : **ne pas pouvoir signer n'empêche jamais le
 * geste**, et la forme canonique produite ici est celle que la Forge attend —
 * à l'octet près.
 *
 * Elles emploient un VRAI `ssh-keygen`, un VRAI agent et de vraies clés
 * jetables : doubler la cryptographie ne prouverait que la fidélité du doublon,
 * et c'est justement le comportement d'OpenSSH avec un agent qui décide de la
 * commande (§36.10.8).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  signer, canonique, classer, entetes, VERSION, NAMESPACE, CHAMPS,
  SANS_CLE, AGENT_MUET, ECHEC, MOTIFS,
} from './signature.js';

const INTENTION = {
  method: 'POST', path: '/v1/sparks', actor: 'console/prod',
  ts: '2026-08-21T00:50:00+00:00', action: 'spark.create',
  body: { name: 'essai' },
};

/** Une clé jetable, et son agent. Le tout retiré à la fin. */
function atelier() {
  const dossier = mkdtempSync(join(tmpdir(), 'spark-sig-'));
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'resp',
                              '-f', join(dossier, 'resp')], { stdio: 'ignore' });
  const pub = readFileSync(join(dossier, 'resp.pub'), 'utf8').split(' ');
  writeFileSync(join(dossier, 'signataires'),
                `console/prod ${pub[0]} ${pub[1]}\n`);
  return { dossier, nettoyer: () => rmSync(dossier, { recursive: true, force: true }) };
}

// --- La forme canonique : la MÊME que celle de la Forge (§36.10.3) ----------

test('la forme est TRIÉE, sans espace, et n’omet aucune clé', () => {
  assert.equal(canonique(INTENTION).toString('utf8'),
    '{"action":"spark.create","actor":"console/prod","body":{"name":"essai"},'
    + '"method":"POST","path":"/v1/sparks","ts":"2026-08-21T00:50:00+00:00"}');
});

test('une valeur ABSENTE est sérialisée null, jamais omise', () => {
  // Omettre une clé produirait deux octets différents pour deux intentions
  // équivalentes, et la Forge refuserait une signature parfaitement valide.
  const octets = canonique({ method: 'GET', path: '/x' }).toString('utf8');
  assert.match(octets, /"body":null/);
  assert.match(octets, /"actor":null/);
  assert.match(octets, /"ts":null/);
  assert.match(octets, /"action":null/);
});

test('un champ HORS LISTE n’entre pas dans les octets', () => {
  const octets = canonique({ ...INTENTION, surprise: 'x' }).toString('utf8');
  assert.ok(!octets.includes('surprise'));
});

test('la version et l’espace de noms sont ceux de la Forge', () => {
  // Les désynchroniser ferait produire des signatures que la Forge refuse, ou
  // pire, qu'elle accepte en les rangeant sous une version qu'elle ne sait pas
  // rejouer.
  assert.equal(VERSION, 'sshsig-v1');
  assert.equal(NAMESPACE, 'spark-audit');
  assert.deepEqual([...CHAMPS].sort(),
    ['action', 'actor', 'body', 'method', 'path', 'ts']);
});

// --- Ne pas pouvoir signer n'empêche JAMAIS le geste (§36.10.8) -------------

test('sans clé configurée, on rend un MOTIF et jamais une erreur', async () => {
  // §36.10.1 appliqué à l'autre bout : refuser d'agir faute de signature ferait
  // de ce mécanisme un contrôle d'accès.
  const vu = await signer(INTENTION, {});
  assert.equal(vu.motif, SANS_CLE);
  assert.ok(vu.signed, 'les octets restent calculés');
  assert.ok(!vu.signature);
});

test('sans agent NI clé privée, le motif dit ce qui manque VRAIMENT', async () => {
  // MESURÉ : OpenSSH rend « Load key … : No such file or directory ». Ce message
  // nomme un fichier que l'exploitant n'a pas demandé (§14.7).
  const a = atelier();
  try {
    rmSync(join(a.dossier, 'resp'));
    const vu = await signer(INTENTION, {
      signingKey: join(a.dossier, 'resp.pub'),
      // L'agent du poste ne doit pas sauver ce cas : on l'écarte.
      spawn: (p, args, o) => spawn(p, args,
        { ...o, env: { ...process.env, SSH_AUTH_SOCK: '' } }),
    });
    assert.equal(vu.motif, AGENT_MUET);
    assert.match(MOTIFS[AGENT_MUET], /ssh-add/, 'le motif dit quoi FAIRE');
    assert.ok(!/No such file/.test(MOTIFS[AGENT_MUET]),
      'le message d’OpenSSH n’est pas montré tel quel');
  } finally {
    a.nettoyer();
  }
});

test('un échec NON RECONNU n’est pas rangé dans « agent muet »', () => {
  // Conclure sur un doute reviendrait à conclure toujours, et enverrait charger
  // une clé alors que le défaut est ailleurs.
  assert.equal(classer(0, ''), null);
  assert.equal(classer(255, 'Load key "x": No such file'), AGENT_MUET);
  assert.equal(classer(255, 'quelque chose d’autre'), ECHEC);
});

test('sans signature, AUCUN en-tête n’est posé', () => {
  // Envoyer une signature vide ferait refuser le geste par la Forge en 422,
  // alors que le §36.10.1 veut précisément qu'il passe.
  assert.deepEqual(entetes({ motif: SANS_CLE, signed: 'abc' }), {});
  assert.deepEqual(entetes(null), {});
  assert.deepEqual(entetes({ signature: 'sig', signed: 'abc' }),
    { 'x-spark-signature': 'sig', 'x-spark-signed': 'abc' });
});

// --- La signature RÉELLE, par la clé privée puis par l'AGENT ----------------

test('une signature produite ici se VÉRIFIE avec ssh-keygen', async () => {
  const a = atelier();
  try {
    const vu = await signer(INTENTION, { signingKey: join(a.dossier, 'resp') });
    assert.ok(vu.signature, vu.motif ?? 'signature attendue');
    assert.ok(!vu.signature.includes('\n'), 'elle tient sur UNE ligne (§36.10.7)');

    // On remet l'armure, comme la Forge le fait, et on vérifie pour de vrai.
    const corps = vu.signature.match(/.{1,70}/g).join('\n');
    writeFileSync(join(a.dossier, 'g.sig'),
      `-----BEGIN SSH SIGNATURE-----\n${corps}\n-----END SSH SIGNATURE-----\n`);
    const verif = spawnSync('ssh-keygen',
      ['-Y', 'verify', '-f', join(a.dossier, 'signataires'),
       '-I', 'console/prod', '-n', NAMESPACE, '-s', join(a.dossier, 'g.sig')],
      { input: Buffer.from(vu.signed, 'base64') });
    assert.equal(verif.status, 0, String(verif.stderr));
  } finally {
    a.nettoyer();
  }
});

test('avec un AGENT, la clé privée n’est PAS lue sur le disque', async () => {
  // C'est la propriété du §36.3, et elle vaut ici pour la console elle-même :
  // elle signe sans jamais tenir le secret. MESURÉ le 2026-08-21.
  const a = atelier();
  const agent = spawnSync('ssh-agent', ['-s'], { encoding: 'utf8' });
  const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(agent.stdout ?? '')?.[1];
  const pid = /SSH_AGENT_PID=([0-9]+);/.exec(agent.stdout ?? '')?.[1];
  if (!socket) {
    a.nettoyer();
    return; // pas d'agent sur cette machine : la preuve suivante reste valable
  }
  try {
    spawnSync('ssh-add', [join(a.dossier, 'resp')],
              { env: { ...process.env, SSH_AUTH_SOCK: socket } });
    // La clé privée QUITTE le disque : seul l'agent peut encore signer.
    rmSync(join(a.dossier, 'resp'));

    const vu = await signer(INTENTION, {
      signingKey: join(a.dossier, 'resp.pub'),
      spawn: (p, args, o) => spawn(p, args,
        { ...o, env: { ...process.env, SSH_AUTH_SOCK: socket } }),
    });
    assert.ok(vu.signature, `l’agent devait signer (${vu.motif ?? ''})`);
  } finally {
    if (pid) spawnSync('kill', [pid]);
    a.nettoyer();
  }
});

// --- Le doublon (§36.10.8) --------------------------------------------------

test('le doublon remplace la COMMANDE, pas le mécanisme', async () => {
  // Même motif et même forme qu'au §37.4.2 bis : la sérialisation, les en-têtes
  // et l'échec dit restent ceux de la production.
  const a = atelier();
  try {
    const vu = await signer(INTENTION, {
      doublon: 'cp "$0.prepare" "$0.sig" 2>/dev/null || '
        + 'printf -- "-----BEGIN SSH SIGNATURE-----\\nZmF1c3Nl\\n'
        + '-----END SSH SIGNATURE-----\\n" > "$0.sig"',
    });
    assert.equal(vu.signature, 'ZmF1c3Nl');
    assert.equal(vu.signed, canonique(INTENTION).toString('base64'));
  } finally {
    a.nettoyer();
  }
});

test('un doublon qui ÉCHOUE laisse le geste partir', async () => {
  const vu = await signer(INTENTION, { doublon: 'exit 3' });
  assert.equal(vu.motif, ECHEC);
  assert.ok(!vu.signature);
});

// --- L'inventaire porte la clé, sans jamais porter de secret ---------------

test('l’inventaire retient signingKey, pour TOUS les genres de serveur', async () => {
  // Signer ne dépend pas de la façon d'atteindre la Forge : un alias, un serveur
  // SSH et un serveur local se signent pareil.
  const { validate } = await import('./inventory.js');
  for (const brut of [
    { name: 'a', kind: 'ssh', host: '203.0.113.10', signingKey: '/k.pub' },
    { name: 'b', kind: 'alias', sshHost: 'forge', signingKey: '/k.pub' },
    { name: 'c', kind: 'local', signingKey: '/k.pub' },
  ]) {
    assert.equal(validate(brut).signingKey, '/k.pub', brut.kind);
  }
});

test('un serveur SANS clé de signature n’en invente pas', () => {
  // §14.6 : absent n'est pas vide. Une chaîne vide ferait lancer `ssh-keygen`
  // sur un chemin qui n'existe pas, et rendrait un échec là où il n'y a rien.
  return import('./inventory.js').then(({ validate }) => {
    const vu = validate({ name: 'a', kind: 'ssh', host: '203.0.113.10' });
    assert.ok(!('signingKey' in vu));
  });
});

// --- Le RELAIS signe, et ne bloque jamais (§36.10.8) ------------------------

test('le relais SIGNE une écriture et pose les deux en-têtes', async () => {
  const { createConsoleHost } = await import('./main.js');
  const { mkdtemp } = await import('node:fs/promises');
  const vues = [];
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod',
                 server: { name: 'prod', signingKey: '/k.pub' },
                 jumpArgs: () => [] };
  const dossier = await mkdtemp(join(tmpdir(), 'spark-relais-'));
  const { server } = createConsoleHost({
    tunnels: { require: () => faux, get: () => faux, list: () => [faux],
               close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    // Le doublon remplace la COMMANDE de signature, pas le mécanisme : la
    // sérialisation, les en-têtes et l'échec dit restent ceux de la production.
    signIntention: (intention) => signer(intention, {
      doublon: 'printf -- "-----BEGIN SSH SIGNATURE-----\\nc2lnbmVl\\n'
        + '-----END SSH SIGNATURE-----\\n" > "$0.sig"' }),
    env: {},
    fetch: async (url, options = {}) => {
      vues.push({ url: String(url), headers: options.headers ?? {} });
      return new Response('{}', { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/v1/sparks?server=prod`, {
      method: 'POST', body: JSON.stringify({ name: 'essai' }) });
    const vu = vues.at(-1);
    assert.equal(vu.headers['x-spark-signature'], 'c2lnbmVl');
    // Les octets signés décrivent bien CETTE requête (§36.10.7).
    const octets = JSON.parse(Buffer.from(vu.headers['x-spark-signed'], 'base64'));
    assert.equal(octets.method, 'POST');
    assert.equal(octets.path, '/v1/sparks');
    assert.equal(octets.actor, 'console/prod');
    assert.deepEqual(octets.body, { name: 'essai' });

    // Une LECTURE n'est pas signée : le §36.7 ne la journalise pas, et signer ce
    // qui ne laisse pas de trace ne prouverait rien.
    await fetch(`${base}/api/v1/sparks?server=prod`);
    assert.ok(!('x-spark-signature' in vues.at(-1).headers));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('un relais qui ne peut PAS signer laisse quand même passer le geste', async () => {
  // §36.10.1 : refuser d'agir faute de signature ferait de ce mécanisme un
  // contrôle d'accès. C'est le cas de l'exploitant dont l'agent vient de se
  // vider, et son produit ne doit pas se verrouiller.
  const { createConsoleHost } = await import('./main.js');
  const { mkdtemp } = await import('node:fs/promises');
  const vues = [];
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod',
                 server: { name: 'prod' }, jumpArgs: () => [] };
  // Aucune clé, aucun doublon : rien ne peut signer, et c'est le cas éprouvé.
  const dossier = await mkdtemp(join(tmpdir(), 'spark-relais-'));
  const { server } = createConsoleHost({
    tunnels: { require: () => faux, get: () => faux, list: () => [faux],
               close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    fetch: async (url, options = {}) => {
      vues.push(options.headers ?? {});
      return new Response('{}', { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/v1/sparks?server=prod`, {
      method: 'POST', body: JSON.stringify({ name: 'essai' }) });
    assert.equal(r.status, 200, 'le geste passe');
    // Aucune signature vide n'est envoyée : la Forge refuserait en 422.
    assert.ok(!('x-spark-signature' in vues.at(-1)));
    assert.ok(!('x-spark-signed' in vues.at(-1)));
    // …et l'acteur, lui, est toujours déclaré.
    assert.equal(vues.at(-1)['x-spark-actor'], 'console/prod');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
