/**
 * @verifies docs/BACKLOG.md#SPK-186 · docs/DAT.md §75.9 (une ligne `script` se montre avec sa commande
 *           exacte et le compte qui l'exécutera ; valider avant d'accepter), §55.5 (ce qui n'est pas retenu
 *           reste en attente), §55.8 (ce que l'écran montre est ce que l'on applique)
 *
 * Ce que ces preuves verrouillent : la commande d'un script est montrée EXACTEMENT ; une ligne que le
 * serveur refuse bloque « Ajouter » jusqu'à ce qu'on la décoche, et reste dans la cellule ; un verdict
 * d'une version périmée du fichier ne vaut rien ; ce qui part est une définition structurée.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPOSITIONS_VIDE, comprendre, entreesAppliquees, lignesAConserver, renderPropositions, verdictDe, refusServeur,
} from './spark-suggestions.js';

const CORPS = [
  '# Page publique.',
  'accueil http */5 * * * * 3 200 https://crm.example.com/',
  '',
  '# Si la base ne répond pas, le site non plus.',
  'base script */10 * * * * 2 0 docker compose -f /srv/crm/compose.yml exec -T db pg_isready',
  '',
  'interne http */5 * * * * 3 200 https://crm.interne.example/sante',
].join('\n');
const SUGGESTION = { kind: 'health', present: true, body: CORPS, sha256: 'abc', path: '/etc/spark/health.?' };
const ui = (extra = {}) => ({ ...PROPOSITIONS_VIDE, status: 'pret', items: [SUGGESTION], ouvert: 'health',
                              exclues: {}, verdicts: {}, ...extra });
const VERDICTS = (parLigne, sha = 'abc') => ({ health: { sha, parLigne } });
const rendu = (u) => renderPropositions(u, ['health']);

test('comprendre : trois sondes, avec leur numéro de ligne, leur étiquette et leur nom', () => {
  const { entrees, refus } = comprendre(SUGGESTION);
  assert.deepEqual(entrees.map((e) => [e.name, e.nom, e.kind, e.ligne]),
    [['accueil', 'accueil', 'http', 2], ['base', 'base', 'script', 5], ['interne', 'interne', 'http', 7]]);
  assert.equal(entrees[1].commentaire, 'Si la base ne répond pas, le site non plus.');
  assert.equal(refus.length, 0);
});

test('la bannière nomme la nature « sondes » et compte les lignes', () => {
  const html = rendu(ui({ ouvert: null }));
  assert.match(html, /<h2 id="titre-sugg-health">Sondes proposées/);
  assert.match(html, /3 sonde\(s\) proposée\(s\) depuis la\s+cellule/);
  assert.match(html, /\/etc\/spark\/health\.\?/);
});

test('une ligne SCRIPT se montre avec sa commande EXACTE et le compte qui l\'exécutera', () => {
  const html = rendu(ui());
  assert.match(html, /<pre class="technique bloc-cle" aria-label="Commande exacte">docker compose -f \/srv\/crm\/compose\.yml exec -T db pg_isready<\/pre>/);
  assert.match(html, /s’exécutera dans la cellule, sous le compte de la pile/);
});

test('une ligne HTTPS montre son adresse et son statut attendu, une cadence et un seuil', () => {
  const html = rendu(ui());
  assert.match(html, /https:\/\/crm\.example\.com\/<\/span>\s*<p class="absence">statut attendu 200/);
  assert.match(html, /\*\/5 \* \* \* \*/);
  assert.match(html, /seuil : 3 échec\(s\)/);
});

test('accepter un script AVERTIT : c\'est autoriser l\'exécution répétée de ce texte', () => {
  const html = rendu(ui());
  assert.match(html, /<strong>1 ligne\(s\) script<\/strong>/);
  assert.match(html, /telles qu’elles sont écrites/);
  // Écarté, le script n'avertit plus.
  assert.equal(rendu(ui({ exclues: { health: new Set([5]) } })).includes('ligne(s) script'), false);
});

test('le tableau a ses cinq colonnes, dont la vérification du serveur', () => {
  assert.match(rendu(ui()), /<th>Retenir<\/th><th>Nom<\/th><th>Type et cadence<\/th><th>Cible<\/th><th>Vérification<\/th>/);
});

// --- le verdict du serveur ---------------------------------------------------------------------------------

test('sans verdict : « Vérification… » ; valide : pastille ET texte ; refusée : pastille, texte ET raison', () => {
  assert.match(rendu(ui()), /badge--neutral">Vérification…/);
  const parLigne = { 2: { ok: true }, 5: { ok: true }, 7: { ok: false, message: '« crm.interne.example » n’est pas une route de ce Spark' } };
  const html = rendu(ui({ verdicts: VERDICTS(parLigne) }));
  assert.equal((html.match(/badge--success"><span class="badge__point" aria-hidden="true"><\/span>Valide/g) ?? []).length, 2);
  assert.match(html, /badge--danger"><span class="badge__point" aria-hidden="true"><\/span>Refusée<\/span>\s*<p class="absence">« crm\.interne\.example » n’est pas une route de ce Spark/);
});

test('un verdict d\'une AUTRE version du fichier est ignoré', () => {
  const u = ui({ verdicts: VERDICTS({ 2: { ok: true } }, 'perime') });
  assert.equal(verdictDe(u, SUGGESTION, 2), undefined);
  assert.match(rendu(u), /Vérification…/);
  assert.deepEqual(verdictDe(ui({ verdicts: VERDICTS({ 2: { ok: true } }) }), SUGGESTION, 2), { ok: true });
});

test('« Ajouter » est présent mais DÉSACTIVÉ tant qu\'une ligne RETENUE est refusée, et dit lesquelles (§9.9)', () => {
  const refus = { 2: { ok: true }, 5: { ok: true }, 7: { ok: false, message: 'refusée' } };
  const html = rendu(ui({ verdicts: VERDICTS(refus) }));
  assert.match(html, /data-sugg-appliquer="health"[^>]*disabled/);
  assert.match(html, /1 ligne\(s\) refusée\(s\) par le produit :\s+interne/);
  assert.match(html, /resteront dans\s+la cellule, pour que leur auteur les corrige/);
});

test('décocher la ligne refusée libère « Ajouter » : elle reste dans la cellule', () => {
  const refus = { 2: { ok: true }, 5: { ok: true }, 7: { ok: false, message: 'refusée' } };
  const u = ui({ verdicts: VERDICTS(refus), exclues: { health: new Set([7]) } });
  assert.equal(/data-sugg-appliquer="health"[^>]*disabled/.test(rendu(u)), false);
  assert.match(rendu(u), /Ajouter les 2 retenue\(s\)/);
  assert.deepEqual(refusServeur(u, SUGGESTION, comprendre(SUGGESTION).entrees), []);
  // La ligne écartée — et son étiquette — RESTENT dans le fichier.
  assert.deepEqual(lignesAConserver(u, SUGGESTION), [7]);
});

test('une ligne refusée mais NON retenue ne bloque rien ; sans verdict, rien n\'est bloqué non plus', () => {
  assert.equal(/data-sugg-appliquer="health"[^>]*disabled/.test(rendu(ui())), false);
  assert.deepEqual(refusServeur(ui(), SUGGESTION, comprendre(SUGGESTION).entrees), []);
});

// --- ce qui part --------------------------------------------------------------------------------------------------------

test('ce qui part est une DÉFINITION structurée, des lignes retenues seulement, sans le décor de lecture', () => {
  const entrees = comprendre(SUGGESTION).entrees;
  const u = ui({ exclues: { health: new Set([7]) } });
  assert.deepEqual(entreesAppliquees(u, 'health', entrees), [
    { name: 'accueil', kind: 'http', schedule: '*/5 * * * *', threshold: 3, expected: 200, target: 'https://crm.example.com/' },
    { name: 'base', kind: 'script', schedule: '*/10 * * * *', threshold: 2, expected: 0,
      target: 'docker compose -f /srv/crm/compose.yml exec -T db pg_isready' },
  ]);
});

test('lignesAConserver : les lignes non retenues restent, avec l\'étiquette posée juste au-dessus', () => {
  const u = ui({ exclues: { health: new Set([5]) } });
  assert.deepEqual(lignesAConserver(u, SUGGESTION), [4, 5]);          // l'étiquette (4) et la ligne (5)
});

test('une ligne illisible est un refus nommé, jamais perdue, et elle reste dans la cellule', () => {
  const s = { ...SUGGESTION, body: 'bon http */5 * * * * 3 200 https://a.example.com/\ncassee http */5 * * * * 0 200 https://a.example.com/' };
  const u = ui({ items: [s] });
  assert.match(rendu(u), /1 ligne\(s\) refusée\(s\)<\/strong>/);
  assert.match(rendu(u), /ligne 2 :\s+<span class="technique">cassee http/);
  assert.deepEqual(lignesAConserver(u, s), [2]);
});

test('une proposition vide de lignes lisibles le dit (§14.5)', () => {
  const s = { ...SUGGESTION, body: '# rien\n' };
  assert.match(rendu(ui({ items: [s] })), /Rien de lisible dans cette proposition/);
});

test('rien n\'est rendu sans proposition de santé, ni quand la lecture a échoué', () => {
  assert.equal(rendu({ ...PROPOSITIONS_VIDE, status: 'pret', items: [] }), '');
  assert.equal(rendu({ ...PROPOSITIONS_VIDE, status: 'erreur' }), '');
});

test('les noms et cibles hostiles sont échappés', () => {
  const s = { ...SUGGESTION, body: 'x script */5 * * * * 3 0 echo "<img src=x onerror=alert(1)>"' };
  assert.equal(rendu(ui({ items: [s] })).includes('<img'), false);
});
