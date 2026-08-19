/**
 * @verifies docs/BACKLOG.md#SPK-21 · docs/DAT.md §26 (les trois surfaces),
 *           §26.2, §26.3, §26.4, §26.5 · §17.2, §18.4, §18.5, §19.3, §19.4 ·
 *           docs/DESIGN_SYSTEM.md §6.19, §6.22, §6.23, §6.24, §14.7
 *
 * Le coeur de l'unite : l'acceptation de perdre des instantanes plus recents
 * n'est offerte qu'APRES le refus du serveur, jamais avant (§26.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderRoutesPanel, renderKeysPanel, renderSnapshotsPanel,
  renderBlockedRestore, formatDate, ADMIN_VIDE,
} from './spark-admin.js';

const SPARK = { name: 'crm', ipv4_address: '10.77.0.16' };
const ui = (surcharge = {}) => ({ ...ADMIN_VIDE, ...surcharge,
                                  values: { ...ADMIN_VIDE.values, ...(surcharge.values ?? {}) } });

// --- L'ORDRE REFUS PUIS ACCEPTATION (§26.5) ---------------------------------
// C'est la regle a ne pas inverser : une case cochee d'avance le serait par
// habitude, et ferait perdre des instantanes jamais regardes.

const INSTANTANES = [
  { incus_name: 'avant-changement', created_at: '2026-08-19T10:00:00', size_bytes: 0 },
  { incus_name: 'apres-migration', created_at: '2026-08-19T14:30:00', size_bytes: 1024 ** 3 },
];

test("aucune acceptation de perte n'est offerte avant le refus du serveur", () => {
  const sansRefus = renderSnapshotsPanel(SPARK, INSTANTANES, ui());
  assert.ok(!sansRefus.includes('data-accepte-perte'),
    "l'acceptation ne doit exister nulle part tant que le serveur n'a rien refuse");
  assert.ok(!sansRefus.includes('accept_losing_newer'));

  // Meme en pleine confirmation de restauration : la case n'est pas la non plus.
  const enConfirmation = renderSnapshotsPanel(SPARK, INSTANTANES,
    ui({ confirming: { kind: 'snapshot-restore', id: 'avant-changement' } }));
  assert.ok(enConfirmation.includes('data-confirme-restauration'));
  assert.ok(!enConfirmation.includes('data-accepte-perte'),
    'la confirmation ordinaire ne doit pas anticiper la perte des plus recents');
});

test("le refus liste NOMMEMENT les instantanes bloquants, puis offre l'acceptation", () => {
  const rendu = renderSnapshotsPanel(SPARK, INSTANTANES, ui({
    refusal: { panel: 'snapshot', snapshot: 'avant-changement',
               message: 'Des instantanés plus récents existent.',
               blocking: ['apres-migration'] },
  }));
  assert.ok(rendu.includes('apres-migration'), 'le bloquant doit etre nomme');
  assert.ok(rendu.includes('data-accepte-perte="avant-changement"'));
  assert.ok(rendu.includes('Restaurer en perdant cet instantané'));
});

test('le decompte des bloquants s’accorde en nombre', () => {
  const un = renderBlockedRestore({ snapshot: 'a', blocking: ['x'] });
  assert.ok(un.includes('Restauration de « a » refusée'), 'le refus nomme SA cible');
  assert.ok(un.includes('1 instantané plus récent serait détruit'));
  const trois = renderBlockedRestore({ snapshot: 'a', blocking: ['x', 'y', 'z'] });
  assert.ok(trois.includes('3 instantanés plus récents seraient détruits'));
  assert.ok(trois.includes('Restaurer en perdant ces 3 instantanés'));
});

test('sans bloquant, le bloc de refus de restauration ne rend rien', () => {
  assert.equal(renderBlockedRestore(null), '');
  assert.equal(renderBlockedRestore({ blocking: [] }), '');
});

// --- INSTANTANES : ce qui confirme et ce qui ne confirme pas (§26.5) --------

test('prendre un instantane ne demande aucune confirmation', () => {
  // Revise avec SPK-33 : la saisie est recueillie par une modale (§6.27). Une
  // modale n'est PAS une confirmation et l'ouvrir n'en tient pas lieu ; ce que
  // ce test verifie — aucun bloc de confirmation pour un geste qui ne detruit
  // rien — est inchange.
  const rendu = renderSnapshotsPanel(SPARK, [], ui({ open: 'snapshot' }));
  assert.ok(rendu.includes('data-modale="snapshot"'));
  assert.ok(!rendu.includes('class="confirmation"'),
    'aucune confirmation pour un geste qui ne detruit rien');
});

test('supprimer et restaurer confirment, en nommant l’instantane', () => {
  const suppression = renderSnapshotsPanel(SPARK, INSTANTANES,
    ui({ confirming: { kind: 'snapshot-delete', id: 'apres-migration' } }));
  assert.ok(suppression.includes('Supprimer « apres-migration » ?'));
  assert.ok(suppression.includes('bouton--destructif'));

  const restauration = renderSnapshotsPanel(SPARK, INSTANTANES,
    ui({ confirming: { kind: 'snapshot-restore', id: 'avant-changement' } }));
  assert.ok(restauration.includes('Restaurer « avant-changement » ?'));
  assert.ok(restauration.includes('Ce qui a été écrit depuis est perdu'));
});

test("l'option stateful n'est jamais proposee (§19.3)", () => {
  const rendu = renderSnapshotsPanel(SPARK, INSTANTANES, ui({ open: 'snapshot' }));
  assert.ok(!/stateful/i.test(rendu), 'un bouton qui echoue a l’usage vaut moins que pas de bouton');
});

test('le formulaire enonce que l’instantane consomme le quota (§19.4)', () => {
  const rendu = renderSnapshotsPanel(SPARK, [], ui({ open: 'snapshot' }));
  assert.ok(rendu.includes('consomme le quota disque du Spark'));
});

test('un instantane n’est jamais presente comme une sauvegarde (§19.5)', () => {
  const rendu = renderSnapshotsPanel(SPARK, INSTANTANES, ui());
  assert.ok(rendu.includes('ne protège ni de la perte du pool'));
  assert.ok(!/sauvegarde du Spark|sauvegarder/i.test(rendu));
});

test('une absence d’instantane est nommee, pas laissee vide', () => {
  assert.ok(renderSnapshotsPanel(SPARK, [], ui()).includes('Aucun instantané.'));
});

// --- ROUTES (§26.3) ---------------------------------------------------------

const ROUTE_APPLIQUEE = { domain: 'crm.example.com', target_port: 8080, tls: 1,
                          applied_at: '2026-08-19T12:00:00' };
const ROUTE_EN_ATTENTE = { domain: 'test.example.com', target_port: 3000, tls: 0,
                           applied_at: null };

test('une route non appliquee s’affiche en accent, jamais en danger (§18.5)', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_EN_ATTENTE], ui());
  assert.ok(rendu.includes('badge--accent'), 'un retard n’est pas une panne');
  assert.ok(!rendu.includes('badge--danger'));
  assert.ok(rendu.includes('non appliquée'));
  assert.ok(rendu.includes('data-reapplique'), 'la reparation doit etre atteignable');
});

test('une route appliquee ne propose pas de reapplication', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_APPLIQUEE], ui());
  assert.ok(!rendu.includes('data-reapplique'));
  assert.ok(!rendu.includes('non appliquée'));
});

test('reappliquer ne demande aucune confirmation (§6.24)', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_EN_ATTENTE], ui());
  const apresBouton = rendu.slice(rendu.indexOf('data-reapplique'));
  assert.ok(!apresBouton.includes('Confirmer'), 'elle ne detruit rien et n’a aucun parametre');
});

test('retirer une route confirme en nommant le domaine', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_APPLIQUEE],
    ui({ confirming: { kind: 'route', id: 'crm.example.com' } }));
  assert.ok(rendu.includes('Retirer « crm.example.com » ?'));
  assert.ok(rendu.includes('Ce domaine cessera de répondre'));
  assert.ok(rendu.includes('data-confirme-route="crm.example.com"'));
});

test("le champ de port designe le port DU SPARK, pas celui de l'hote (§26.3)", () => {
  const rendu = renderRoutesPanel(SPARK, [], ui({ open: 'route' }));
  assert.ok(rendu.includes('Port du Spark'));
  assert.ok(rendu.includes('pas celui de l’hôte'));
});

test('le formulaire enonce que le TLS depend du DNS (§18.3)', () => {
  const rendu = renderRoutesPanel(SPARK, [], ui({ open: 'route' }));
  assert.ok(rendu.includes('Le DNS est extérieur au produit'));
  assert.ok(!/certificat actif|TLS actif/i.test(rendu),
    'l’ecran ne sait pas si un certificat est emis, il ne doit pas l’affirmer');
});

test("aucun controle d'unicite du domaine cote interface (§18.4, §26.3)", () => {
  // Le domaine saisi existe deja : le formulaire ne s'y oppose pas, et le
  // bouton reste actif. Le refus vient de la base, en 409.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_APPLIQUEE],
    ui({ open: 'route', values: { domain: 'crm.example.com', port: 8080, tls: true } }));
  const soumission = rendu.slice(rendu.indexOf('type="submit"'));
  assert.ok(!soumission.slice(0, 120).includes('disabled'),
    'un controle local ne protegerait de rien face a deux consoles simultanees');
  assert.ok(!/déjà utilisé|deja utilise|existe déjà/i.test(rendu));
});

test('une route sans TLS le dit', () => {
  assert.ok(renderRoutesPanel(SPARK, [ROUTE_EN_ATTENTE], ui()).includes('sans TLS'));
  assert.ok(!renderRoutesPanel(SPARK, [ROUTE_APPLIQUEE], ui()).includes('sans TLS'));
});

test('une absence de route est nommee', () => {
  assert.ok(renderRoutesPanel(SPARK, [], ui()).includes('Aucune route publique'));
});

// --- CLES (§26.4) -----------------------------------------------------------

const CLE = { label: 'poste-martino', fingerprint: 'SHA256:abc123def' };
const REGISTRE = [CLE, { label: 'ci-runner', fingerprint: 'SHA256:zzz999' }];

test("l'empreinte affichee est celle du serveur, pas un condensat recalcule (§17.2)", () => {
  const rendu = renderKeysPanel(SPARK, { keys: [CLE] }, ui());
  assert.ok(rendu.includes('SHA256:abc123def'));
});

test('le registre ne propose que les cles non deja accordees', () => {
  const rendu = renderKeysPanel(SPARK, { keys: [CLE], registry: REGISTRE }, ui({ open: 'key' }));
  assert.ok(rendu.includes('value="ci-runner"'));
  assert.ok(!rendu.includes('value="poste-martino"'),
    'proposer d’accorder une cle deja accordee serait une commande morte (§1.4)');
});

test('quand le registre n’a rien de neuf a proposer, l’absence est nommee', () => {
  const rendu = renderKeysPanel(SPARK, { keys: [CLE], registry: [CLE] }, ui({ open: 'key' }));
  assert.ok(rendu.includes('aucune clé que ce Spark n’ait déjà'));
  assert.ok(!rendu.includes('<select'));
});

test('revoquer ne confirme pas, mais la DERNIERE cle nomme sa consequence (§26.4)', () => {
  const seule = renderKeysPanel(SPARK, { keys: [CLE] }, ui());
  assert.ok(seule.includes('data-revoque="poste-martino"'));
  assert.ok(!seule.includes('Confirmer'), 'le geste est reversible : confirmer banaliserait');
  assert.ok(seule.includes('fermera ce Spark à tout le monde'));

  const deux = renderKeysPanel(SPARK, { keys: REGISTRE }, ui());
  assert.ok(!deux.includes('fermera ce Spark à tout le monde'),
    'la consequence ne vaut que lorsqu’elle est vraie');
});

test('une absence de cle dit ce qu’elle implique', () => {
  const rendu = renderKeysPanel(SPARK, { keys: [] }, ui());
  assert.ok(rendu.includes('personne ne peut s’y connecter'));
});

test('le fragment ssh_config vient du serveur et n’est pas reconstruit (§17.4)', () => {
  const config = 'Host crm\n    HostName 10.77.0.16\n    User root\n    ProxyJump spark-host\n';
  const rendu = renderKeysPanel(SPARK, { keys: [CLE], sshConfig: { config } }, ui());
  assert.ok(rendu.includes('ProxyJump spark-host'));
  assert.ok(rendu.includes('class="fragment technique"'), 'donnee technique (§3.1)');
  assert.ok(rendu.includes('n’expose jamais son port 22'));
});

test("sans fragment rendu par le serveur, l'ecran n'en invente pas", () => {
  const rendu = renderKeysPanel(SPARK, { keys: [CLE], sshConfig: null }, ui());
  assert.ok(!rendu.includes('ProxyJump'));
});

test("l'oubli d'une cle du registre commun est explicitement hors de cet ecran (§26.1)", () => {
  const rendu = renderKeysPanel(SPARK, { keys: [CLE] }, ui());
  assert.ok(rendu.includes('Retirer une clé du registre commun'));
});

test('le formulaire avertit qu’une cle privee est refusee par le registre (§17.2)', () => {
  const rendu = renderKeysPanel(SPARK, { keys: [], registry: REGISTRE }, ui({ open: 'key' }));
  assert.ok(rendu.includes('Seule une clé publique est acceptée'));
});

// --- CONTRAT D'INTERACTION COMMUN (§26.2) -----------------------------------

test('une seule modale a la fois', () => {
  // Revise avec SPK-33. Les declencheurs ne disparaissent plus : ils restent
  // visibles parce que ce sont EUX qui recoivent le focus a la fermeture, et un
  // declencheur disparu n'aurait rien a qui le rendre (§6.27).
  //
  // Ce qui reste verifie est l'invariant : une modale n'en ouvre pas une autre.
  const etat = ui({ open: 'route' });
  assert.ok(renderRoutesPanel(SPARK, [], etat).includes('<dialog'));
  assert.ok(!renderKeysPanel(SPARK, { keys: [] }, etat).includes('<dialog'));
  assert.ok(!renderSnapshotsPanel(SPARK, [], etat).includes('<dialog'));
});

test('le declencheur reste visible pendant la saisie', () => {
  // Il recoit le focus a la fermeture (§6.27) : le faire disparaitre romprait
  // le contrat.
  const rendu = renderRoutesPanel(SPARK, [], ui({ open: 'route' }));
  assert.ok(rendu.includes('data-ouvre="route"'));
});

test('chaque panneau ferme propose son declencheur', () => {
  assert.ok(renderRoutesPanel(SPARK, [], ui()).includes('data-ouvre="route"'));
  assert.ok(renderKeysPanel(SPARK, { keys: [] }, ui()).includes('data-ouvre="key"'));
  assert.ok(renderSnapshotsPanel(SPARK, [], ui()).includes('data-ouvre="snapshot"'));
});

test('un refus du serveur n’efface pas la saisie (§6.27)', () => {
  const rendu = renderRoutesPanel(SPARK, [], ui({
    open: 'route',
    values: { domain: 'nouveau.example.com', port: 9000, tls: false },
    refusal: { panel: 'route', message: 'Ce domaine est déjà pris.' },
  }));
  assert.ok(rendu.includes('value="nouveau.example.com"'));
  assert.ok(rendu.includes('value="9000"'));
  assert.ok(rendu.includes('Ce domaine est déjà pris.'));
});

test('un refus s’affiche DANS la modale qui l’a recu, et nulle part ailleurs', () => {
  // §6.27 : un refus du serveur s'affiche dans la modale, pres du bouton
  // d'engagement. Une modale qui se refermerait sur un refus ferait perdre la
  // saisie et cacherait la raison.
  const etat = ui({ open: 'route', refusal: { panel: 'route', message: 'Refus de route.' } });
  assert.ok(renderRoutesPanel(SPARK, [], etat).includes('Refus de route.'));
  assert.ok(!renderKeysPanel(SPARK, { keys: [] }, etat).includes('Refus de route.'));
  assert.ok(!renderSnapshotsPanel(SPARK, [], etat).includes('Refus de route.'));
});

test('pendant l’envoi, le point d’engagement est desactive et le dit', () => {
  const rendu = renderRoutesPanel(SPARK, [], ui({ open: 'route', busy: true }));
  assert.ok(rendu.includes('disabled'));
  assert.ok(rendu.includes('Envoi…'));
});

test('le point d’engagement NOMME l’action', () => {
  // « Enregistrer » ne dit pas ce qu'il couvre ; « Declarer la route » le dit.
  assert.ok(renderRoutesPanel(SPARK, [], ui({ open: 'route' })).includes('Déclarer la route'));
  assert.ok(renderSnapshotsPanel(SPARK, [], ui({ open: 'snapshot' })).includes('Prendre l’instantané'));
});

test('le nom accessible de la modale est le TITRE DE LA SECTION', () => {
  // §6.27 : c'est ce qui borne sa portee — une modale ouverte depuis « Routes »
  // ne touche que les routes.
  const rendu = renderRoutesPanel(SPARK, [], ui({ open: 'route' }));
  assert.ok(rendu.includes('aria-labelledby="route-titre"'));
  assert.ok(rendu.includes('id="route-titre">Routes publiques'));
});

test('les valeurs de l’utilisateur sont echappees', () => {
  const rendu = renderRoutesPanel(SPARK, [{ domain: '<script>x</script>', target_port: 1,
                                            tls: 1, applied_at: null }], ui());
  assert.ok(!rendu.includes('<script>'));
  assert.ok(rendu.includes('&lt;script&gt;'));
});

test('formatDate rend un horodatage lisible', () => {
  assert.equal(formatDate('2026-08-19T14:30:00.123456'), '2026-08-19 14:30');
  assert.equal(formatDate(null), '');
});
