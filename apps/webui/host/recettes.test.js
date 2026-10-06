/**
 * @verifies docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.6 (les recettes),
 *           §38.6.1 (une fonction, pas une donnée), §38.6.2 (la garde élargie),
 *           §38.6.3 (le compte rendu), §38.6.4 (les deux recettes) · §38.5
 * @verifies docs/BACKLOG.md#SPK-149 · docs/DAT.md §38.6.6 (le nom dans la zone,
 *           plusieurs niveaux, chaque niveau validé ; l'adresse pré-remplie)
 * @verifies docs/BACKLOG.md#SPK-153 · docs/DAT.md §38.6.4 (le « www » est une
 *           option décochée par défaut ; une valeur autre que vrai ou faux est
 *           refusée) · §38.6.4 bis (une recette ne déclare que ce qu'elle écrit)
 *
 * Une recette à moitié posée est pire qu'une recette absente : un `MX` sans SPF
 * fait recevoir du courrier qu'on ne peut pas renvoyer. C'est ce que ces preuves
 * gardent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogue, composer, RECETTES, ValeurManquante , dansLaZone, adressePublique } from './recettes.js';
import { DnsError, FORMES, preparerEnregistrement } from './dns.js';

// --- la garde élargie (§38.6.2) ---------------------------------------------

test('chaque type declare la FORME que sa donnee doit avoir', () => {
  assert.deepEqual(Object.keys(FORMES).sort(),
                   ['A', 'AAAA', 'CNAME', 'MX', 'SRV', 'TXT']);
});

test('un MX exige une PRIORITE puis un nom d’hote', () => {
  // Sans la priorite, le fournisseur refuserait apres coup et avec son propre
  // message — on ne saurait pas que c'est le produit qui a mal compose.
  assert.doesNotThrow(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'MX',
    data: '10 mail.exemple.tech.' }));
  assert.throws(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'MX',
    data: 'mail.exemple.tech.' }), /priorité/);
});

test('un SRV exige ses quatre champs', () => {
  assert.doesNotThrow(() => preparerEnregistrement({
    domain: '_imaps._tcp.exemple.tech', zone: 'exemple.tech', type: 'SRV',
    data: '0 1 993 mail.exemple.tech.' }));
  assert.throws(() => preparerEnregistrement({
    domain: '_imaps._tcp.exemple.tech', zone: 'exemple.tech', type: 'SRV',
    data: '993 mail.exemple.tech.' }), DnsError);
});

test('un TXT vide est refuse : il ne dirait rien', () => {
  assert.throws(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'TXT', data: '   ' }),
    /sans valeur/);
});

test('un type que le produit ne COMPOSE pas est refuse, en les enumerant', () => {
  // Ce n'est pas de la prudence : ecrire un type qu'on ne compose pas serait
  // ecrire une valeur qu'on n'a pas verifiee (§38.6.2).
  assert.throws(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'NS', data: 'ns0.x.' }),
    /le produit compose/);
});

test('une recette n’est PAS une porte derobee : chaque ligne passe la garde', () => {
  // REVISE le 2026-10-06 (SPK-149, §38.6.6) : « autre.fr » etait refuse comme
  // hors zone. Un libelle a plusieurs niveaux se compose desormais DANS la zone
  // — un nom compose ne peut donc plus en sortir, par construction.
  const vu = composer('site-web', { domain: 'autre.fr', address: '203.0.113.7', www: true },
                      { zone: 'exemple.tech' });
  assert.ok(vu.records.every((r) => r.zone === 'exemple.tech'));
  assert.deepEqual(vu.records.map((r) => r.name), ['autre.fr', 'www.autre.fr']);
  // Et chaque ligne passe toujours la garde du §38.5 : l'espace de noms du poste
  // et la forme de la valeur, exactement comme une ecriture simple.
  assert.throws(() => composer('site-web', { domain: 'boutique', address: '203.0.113.7' },
                               { zone: 'exemple.tech', motif: '^essai\\.' }),
                /sort de l'espace de noms/);
  assert.throws(() => composer('site-web', { domain: 'boutique', address: 'pas-une-ip' },
                               { zone: 'exemple.tech' }),
                /invalide pour un A/);
});

// --- le catalogue (§38.6.1) --------------------------------------------------

test('le catalogue vient du CODE et decrit ce que chaque recette reclame', () => {
  const noms = catalogue().map((r) => r.id).sort();
  assert.deepEqual(noms, ['relais-transactionnel', 'site-web']);
  for (const recette of catalogue()) {
    assert.ok(recette.label && recette.description);
    assert.ok(Array.isArray(recette.parametres) && recette.parametres.length > 0);
  }
});

// --- « site-web » (§38.6.4) --------------------------------------------------

test('« site-web » sans la case pose le nom choisi SEUL : un enregistrement, une route (SPK-153)', () => {
  // §38.6.4 révisé le 2026-10-06 : le `www` était posé d'office, sous un
  // sous-domaine aussi — un nom que personne n'avait demandé, et une route qui
  // l'occupait. Décochée, la recette ne pose que ce qu'on a nommé.
  const vu = composer('site-web',
    { domain: 'exemple.tech', address: '203.0.113.7', port: '8080' }, { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => [r.name, r.type, r.data]), [
    ['', 'A', '203.0.113.7'],
  ]);
  assert.deepEqual(vu.routes.map((r) => r.domain), ['exemple.tech'],
                   'une recette ne déclare que ce qu’elle écrit (§38.6.4 bis)');
  assert.equal(vu.records[0].apex, true, 'le domaine nu doit se signaler comme apex');
  assert.ok(vu.records.every((r) => r.role), 'chaque ligne dit ce qu’elle fait');
  assert.equal(vu.incomplete, null, 'elle ne depend d’aucune valeur exterieure');
});

test('« site-web » avec la case pose le nom ET son www, routes comprises (SPK-153)', () => {
  const vu = composer('site-web',
    { domain: 'exemple.tech', address: '203.0.113.7', port: '8080', www: true },
    { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => [r.name, r.type, r.data]), [
    ['', 'A', '203.0.113.7'],
    ['www', 'A', '203.0.113.7'],
  ]);
  assert.deepEqual(vu.routes.map((r) => [r.domain, r.port]),
                   [['exemple.tech', 8080], ['www.exemple.tech', 8080]]);
  assert.ok([...vu.records, ...vu.routes].every((l) => l.role));
});

test('la case décochée, vide ou absente vaut « non » ; toute autre valeur est REFUSÉE (SPK-153)', () => {
  const noms = (www) => composer('site-web',
    { domain: 'boutique', address: '203.0.113.7', www }, { zone: 'exemple.tech' })
    .records.map((r) => r.name);
  for (const non of [false, undefined, null, '']) {
    assert.deepEqual(noms(non), ['boutique'], `« ${non} » vaut « non »`);
  }
  // Un « oui » lu comme un « non » muet ferait croire à l'appelant qu'il a
  // demandé le `www` sans que rien ne soit posé (§38.6.2).
  for (const faux of ['oui', 'true', 'on', 1, 0, {}]) {
    assert.throws(() => noms(faux),
                  (e) => e instanceof DnsError && /« www »/.test(e.message)
                         && /vrai ou faux/.test(e.message),
                  `« ${JSON.stringify(faux)} » doit être refusé en nommant la case`);
  }
});

test('le catalogue décrit la case « www », décochée, juste après le nom (SPK-153)', () => {
  const p = catalogue()[0].parametres;
  assert.equal(catalogue()[0].id, 'site-web');
  const i = p.findIndex((x) => x.nom === 'www');
  assert.equal(p[i - 1]?.nom, 'domain', 'la case suit le champ du nom qu’elle prolonge');
  assert.equal(p[i].aCocher, true);
  assert.notEqual(p[i].defaut, true, 'le produit ne coche pas à la place de l’exploitant');
  assert.match(p[i].label, /www/);
  assert.match(catalogue()[0].description, /si la case est cochée/,
               'la description ne promet plus le « www » sans condition');
  // Vu en capture à 390 px : « www et » se séparaient en fin de ligne. Les
  // espaces intérieures des guillemets sont insécables, partout où la case parle.
  for (const texte of [catalogue()[0].description, p[i].label, p[i].aide]) {
    assert.ok(!/« | »/.test(texte), `espace sécable dans des guillemets : ${texte}`);
  }
});

test('une adresse IPv6 donne un AAAA dans « site-web »', () => {
  assert.throws(() => composer('site-web',
    { domain: 'exemple.tech', address: '2001:db8::1' }, { zone: 'exemple.tech' }),
    /invalide pour un A/,
    'la recette compose des A : une IPv6 doit être REFUSÉE, pas écrite comme un A');
});

// --- « relais-transactionnel » (§38.6.4) ------------------------------------

const RELAIS = { domain: 'noreply.exemple.tech', selector: 'projet-1',
                 dkim: 'v=DKIM1; h=sha256; k=rsa; p=AAAA', policy: 'none' };

test('« relais-transactionnel » compose les quatre enregistrements mesures', () => {
  const vu = composer('relais-transactionnel', RELAIS, { zone: 'exemple.tech' });
  const lignes = vu.records.map((r) => [r.name, r.type]);
  assert.deepEqual(lignes, [
    ['noreply', 'MX'],
    ['noreply', 'TXT'],
    ['_dmarc.noreply', 'TXT'],
    ['projet-1._domainkey.noreply', 'TXT'],
  ]);
  assert.ok(vu.records[0].data.includes('blackhole'));
  assert.ok(vu.records[1].data.includes('_spf.tem.scaleway.com'));
  assert.equal(vu.incomplete, null);
});

test('le MX vers un PUITS est annonce comme tel, pas laisse a deviner', () => {
  // Un exploitant qui l'appliquerait sur un domaine cense RECEVOIR du courrier
  // le couperait. C'est ecrit dans la recette, pas seulement dans le DAT.
  const vu = composer('relais-transactionnel', RELAIS, { zone: 'exemple.tech' });
  assert.ok(/ÉMET et ne reçoit pas/.test(vu.records[0].role));
  assert.ok(/NE REÇOIT PAS/.test(RECETTES['relais-transactionnel'].description));
});

test('SANS la cle DKIM, la recette est posee mais annoncee INCOMPLETE', () => {
  // §38.6 : la valeur DKIM ne s'invente pas. L'inventer produirait une signature
  // invalide, donc exactement l'effet qu'on pretend eviter.
  const vu = composer('relais-transactionnel', { ...RELAIS, dkim: '' },
                      { zone: 'exemple.tech' });
  assert.equal(vu.records.length, 3, 'les trois autres sont posees quand meme');
  assert.ok(vu.incomplete.includes('SANS SIGNATURE'));
  assert.ok(vu.incomplete.includes('console du fournisseur'),
    'elle doit dire OU lire la cle');
});

test('sans SELECTEUR, la recette REFUSE au lieu d’inventer un nom', () => {
  assert.throws(
    () => composer('relais-transactionnel', { ...RELAIS, selector: '' },
                   { zone: 'exemple.tech' }),
    (e) => e instanceof ValeurManquante && e.champ === 'selector');
});

test('une politique DMARC inconnue est refusee en enumerant les trois', () => {
  assert.throws(() => composer('relais-transactionnel',
    { ...RELAIS, policy: 'detruire' }, { zone: 'exemple.tech' }),
    /none, quarantine ou reject/);
});

test('les actions HUMAINES restantes voyagent avec la recette', () => {
  // §38.7 : le produit fait sa part et dit precisement ou s'arrete son pouvoir.
  const vu = composer('relais-transactionnel', RELAIS, { zone: 'exemple.tech' });
  assert.ok(vu.actionsHumaines.length >= 2);
  assert.ok(vu.actionsHumaines.some((a) => /PTR/.test(a)));
});

test('une recette inconnue est refusee', () => {
  assert.throws(() => composer('inexistante', {}, { zone: 'exemple.tech' }),
                /inconnue/);
});

// --- le nom est RELATIF à la zone (§38.6.6) ----------------------------------

test('la zone étant choisie, un libellé vide vaut le domaine lui-même', () => {
  // Redemander le domaine entier faisait ressaisir ce que l'écran sait déjà.
  const vu = composer('site-web', { domain: '', address: '203.0.113.7', www: true },
                      { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => r.name), ['', 'www']);
  assert.equal(vu.records[0].apex, true, 'le premier enregistrement EST l’apex');
});

test('un libellé simple devient un sous-domaine de la zone', () => {
  const vu = composer('site-web', { domain: 'boutique', address: '203.0.113.7' },
                      { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => r.name), ['boutique']);
});

test('le nom COMPLET de la zone reste accepté : c’est une saisie par habitude', () => {
  const vu = composer('site-web', { domain: 'boutique.exemple.tech', address: '203.0.113.7' },
                      { zone: 'exemple.tech' });
  assert.equal(vu.records[0].name, 'boutique');
});

test('un libellé à tiret compose son nom dans la zone, routes comprises (SPK-149)', () => {
  // Le défaut signalé le 2026-10-06 accusait le tiret : il n'y est pour rien.
  // La composition est juste ; c'est l'écran qui écrivait un aperçu périmé.
  const vu = composer('site-web',
                      { domain: 'evoliz-mcp', address: '203.0.113.7', port: '8080', www: true },
                      { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => r.name), ['evoliz-mcp', 'www.evoliz-mcp']);
  assert.deepEqual(vu.routes.map((r) => r.domain),
                   ['evoliz-mcp.exemple.tech', 'www.evoliz-mcp.exemple.tech']);
});

test('un libellé à PLUSIEURS niveaux se compose dans la zone (SPK-149, §38.6.6)', () => {
  // Révisé le 2026-10-06 : il était refusé comme ambigu. La zone s'affiche en
  // suffixe du champ et l'aperçu montre le nom complet avant d'écrire : le
  // refus interdisait un cas ordinaire sans rien protéger.
  assert.equal(dansLaZone('mcp.evoliz', 'exemple.tech'), 'mcp.evoliz.exemple.tech');
  const vu = composer('site-web',
                      { domain: 'mcp.evoliz', address: '203.0.113.7', port: '8080', www: true },
                      { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => r.name), ['mcp.evoliz', 'www.mcp.evoliz']);
  assert.deepEqual(vu.routes.map((r) => r.domain),
                   ['mcp.evoliz.exemple.tech', 'www.mcp.evoliz.exemple.tech']);
});

test('le suffixe de la zone tapé par habitude n’est pas doublé, à plusieurs niveaux aussi', () => {
  assert.equal(dansLaZone('mcp.evoliz.exemple.tech', 'exemple.tech'),
               'mcp.evoliz.exemple.tech');
  assert.equal(dansLaZone('MCP.Evoliz.', 'exemple.tech'), 'mcp.evoliz.exemple.tech',
               'la casse et le point final de la racine ne changent pas le nom');
});

test('un niveau vide ou mal formé est REFUSÉ, et la règle est nommée (§38.6.6)', () => {
  // Accepter les points oblige à refuser ce qu'ils permettent de mal écrire :
  // `mcp..evoliz` composerait un nom que ni le fournisseur ni `sparkd` n'acceptent.
  for (const faux of ['mcp..evoliz', '.evoliz', '-mcp', 'mcp-', 'mc_p', 'mc p',
                      'évoliz', 'a'.repeat(64), '*']) {
    assert.throws(() => dansLaZone(faux, 'exemple.tech'),
                  (e) => e instanceof DnsError && /1 à 63 lettres, chiffres ou tirets/.test(e.message),
                  `« ${faux} » doit être refusé`);
  }
  assert.equal(dansLaZone('a'.repeat(63), 'exemple.tech'), `${'a'.repeat(63)}.exemple.tech`);
  assert.equal(dansLaZone('9-a', 'exemple.tech'), '9-a.exemple.tech');
});

test('la garde du libellé tient aussi pour le relais transactionnel', () => {
  const vu = composer('relais-transactionnel',
                      { domain: 'envoi.noreply', selector: 'projet-1' },
                      { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => r.name),
                   ['envoi.noreply', 'envoi.noreply', '_dmarc.envoi.noreply']);
  assert.throws(() => composer('relais-transactionnel',
                               { domain: 'envoi..noreply', selector: 'projet-1' },
                               { zone: 'exemple.tech' }), DnsError);
});

test('le rôle de chaque ligne dit « sous-domaine » quand le nom n’est pas l’apex (SPK-149)', () => {
  // Vu en capture le 2026-10-06 : « Le domaine nu est servi par ce Spark » à
  // côté de `route evoliz-mcp.exemple.tech` — faux à l'écran, et c'est la
  // phrase qui fait croire que la racine est visée.
  const sous = composer('site-web', { domain: 'evoliz-mcp', address: '203.0.113.7', www: true },
                        { zone: 'exemple.tech' });
  assert.ok([...sous.records, ...sous.routes].every((l) => !/domaine (nu|lui-même)/.test(l.role)));
  assert.match(sous.records[0].role, /sous-domaine/);
  assert.match(sous.routes[0].role, /sous-domaine/);
  const nu = composer('site-web', { domain: '', address: '203.0.113.7' },
                      { zone: 'exemple.tech' });
  assert.match(nu.records[0].role, /domaine lui-même/);
  assert.match(nu.routes[0].role, /domaine nu/);
});

test('l’aide du champ dit qu’un sous-domaine peut avoir plusieurs niveaux', () => {
  const p = catalogue()[0].parametres.find((x) => x.nom === 'domain');
  assert.match(p.aide, /plusieurs niveaux/);
  // Vu en capture : « et « mcp.api » se séparaient en fin de ligne. Les espaces
  // intérieures des guillemets sont insécables.
  assert.ok(p.aide.includes('«\u00a0mcp.api\u00a0»'));
});

// --- ce que la console SAIT n'est pas redemandé (§38.6.6) --------------------

test('l’adresse de la Forge est pré-remplie depuis le serveur courant', () => {
  const p = catalogue({ adresseForge: '203.0.113.7' })[0]
    .parametres.find((x) => x.nom === 'address');
  assert.equal(p.defaut, '203.0.113.7');
  assert.match(p.aide, /Pré-rempli/);
});

test('sans adresse connaissable, le champ reste VIDE plutôt que faux', () => {
  // §14.6 : proposer une valeur fausse est pire que ne rien proposer.
  const p = catalogue({ adresseForge: null })[0]
    .parametres.find((x) => x.nom === 'address');
  assert.equal(p.defaut, undefined);
  assert.doesNotMatch(p.aide, /Pré-rempli/);
});

test('une Forge locale ou déclarée par alias n’a pas d’adresse publique', () => {
  assert.equal(adressePublique({ kind: 'local', host: '127.0.0.1' }), null);
  assert.equal(adressePublique({ kind: 'alias', sshHost: 'ma-forge' }), null);
  assert.equal(adressePublique({ kind: 'ssh', host: '51.158.54.202' }), '51.158.54.202');
  assert.equal(adressePublique(null), null);
});

test('l’adresse DECLAREE prime sur celle qu’on deduirait du transport (SPK-77)', () => {
  // §38.8.5 : c'est ce qui leve la limite connue du §38.6.6 — un alias `ssh` et
  // une Forge locale n'avaient AUCUNE adresse connaissable.
  assert.equal(adressePublique({ kind: 'alias', sshHost: 'ma-forge',
                                 publicAddress: '203.0.113.10' }), '203.0.113.10');
  assert.equal(adressePublique({ kind: 'local', host: '127.0.0.1',
                                 publicAddress: '203.0.113.10' }), '203.0.113.10');
  assert.equal(adressePublique({ kind: 'ssh', host: '51.158.54.202',
                                 publicAddress: '203.0.113.10' }), '203.0.113.10',
               'la declaration prime : le transport peut passer par un rebond');
});
