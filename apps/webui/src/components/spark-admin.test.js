/**
 * @verifies docs/BACKLOG.md#SPK-49 · docs/DAT.md §39 (les ports publies),
 *           §39.2, §39.3, §39.5
 * @verifies docs/BACKLOG.md#SPK-89 · docs/DAT.md §18.3 ter (la cible d'une route
 *           se corrige : le port et le TLS, jamais le domaine ni le Spark),
 *           §18.5 (l'ecart reste visible)
 * @verifies docs/BACKLOG.md#SPK-88 · docs/DAT.md §38.6.4 bis (une recette pose
 *           AUSSI sa route), §38.6.4 ter (un seul gabarit pour trois blocs)
 * @verifies docs/BACKLOG.md#SPK-48 · docs/DAT.md §18.3 bis (le joker, la
 *           preseance du plus specifique, la vue depuis le joker) · §14.7, §14.8
 * @verifies docs/BACKLOG.md#SPK-78 · docs/DAT.md §38.9 (une ecriture DNS se
 *           verifie), §38.9.1 (relire plutot que persister), §38.9.2 (conforme
 *           ne veut pas dire resolu) · docs/DESIGN_SYSTEM.md §14.5
 * @verifies docs/BACKLOG.md#SPK-47 · docs/DAT.md §38 (le DNS entre dans le
 *           perimetre), §38.1.1 (trois etats : sans jeton, refuse, sans zone),
 *           §38.3, §38.4, §38.5 — pour « Pointer le domaine ».
 * @verifies docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.1.1 ·
 *           docs/DESIGN_SYSTEM.md §6.13 (« vide » et « erreur » sont deux
 *           etats), §14.5 (une absence utile est NOMMEE) — le selecteur de
 *           zones porte la raison de son vide.
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
  renderBlockedRestore, formatDate, ADMIN_VIDE, renderProtectedRevocation, zonePour,
  renderPortsPanel, refusZones, renderEtatDns, renderVerification,
  refusEcritureRecette,
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
  assert.ok(rendu.includes('pas celui de la Forge'));
});

test('le formulaire enonce que le TLS depend du DNS (§18.3)', () => {
  // REVISE par SPK-47 : l'ecran disait « Le DNS est exterieur au produit ».
  // C'etait vrai, et c'etait l'obstacle — SPK-12 reste ouvert faute d'un domaine
  // qui resolve. Le produit pilote desormais le DNS (§38), donc la phrase est
  // devenue fausse et l'attente qui la figeait avec elle.
  //
  // Ce que la preuve etablit est INCHANGE, et double : le formulaire dit que
  // l'emission depend de la resolution, et il n'affirme JAMAIS qu'un certificat
  // est emis — l'ecran ne le sait pas.
  const rendu = renderRoutesPanel(SPARK, [], ui({ open: 'route' }));
  assert.ok(rendu.includes('résolve déjà vers'),
    'l’emission depend de la resolution, et le formulaire doit le dire');
  assert.ok(rendu.includes('soumise à la propagation'),
    'poser un enregistrement ne le fait pas resoudre (§38.4)');
  assert.ok(!rendu.includes('Le DNS est extérieur au produit'),
    'cette phrase a cesse d’etre vraie : le produit pilote le DNS (§38)');
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


// --- revoquer traverse un Spark protege, et le NOMME (SPK-34) --------------

test('la confirmation NOMME les Sparks proteges, elle ne les compte pas', () => {
  // §6.23 : « les objets protégés concernés sont NOMMÉS, pas comptés ».
  const html = renderProtectedRevocation({
    label: 'poste-responsable', protected_sparks: ['postgres-dedie', 'crm-production'],
  });
  assert.match(html, /postgres-dedie/);
  assert.match(html, /crm-production/);
  assert.match(html, /2 Sparks protégés/);
});

test("la confirmation dit qu'AUCUNE protection ne sera levee", () => {
  // §35.2 : l'action aboutit sans qu'aucune protection ait a etre levee, et
  // sans en lever aucune. Le taire ferait croire a un desarmement au passage.
  const html = renderProtectedRevocation({ label: 'k', protected_sparks: ['a'] });
  assert.match(html, /Aucune protection ne sera levée/);
});

test("le bouton d'acceptation n'est PAS destructif", () => {
  // §6.23 : revoquer un acces REDUIT un risque. Ne pas employer `danger` parce
  // qu'une action est importante.
  const html = renderProtectedRevocation({ label: 'k', protected_sparks: ['a'] });
  assert.match(html, /data-accepte-protege="k"/);
  assert.ok(!html.includes('bouton--destructif'));
});

test("sans Spark protege, il n'y a AUCUNE confirmation a rendre", () => {
  // §35.5 : « s'il n'y a aucun Spark protégé, il n'y a pas de refus du tout ».
  assert.equal(renderProtectedRevocation({ label: 'k', protected_sparks: [] }), '');
  assert.equal(renderProtectedRevocation(null), '');
});

// --- « Pointer le domaine » (SPK-47, docs/DAT.md §38) -----------------------

const ROUTE_DNS = { domain: 'test.spark.lelabs.tech', target_port: 8080, tls: true,
                    applied_at: '2026-08-20T09:00:00' };
const ZONES = [{ zone: 'lelabs.tech', status: 'active' },
               { zone: 'staging.lelabs.tech', status: 'active' }];

test('un domaine sans zone au compte ne pre-choisit rien', () => {
  assert.equal(zonePour('app.autre.tech', ZONES), '');
});
const dnsUi = (dns = {}, valeurs = {}) => ui({
  open: 'dns',
  dns: { ...ADMIN_VIDE.dns, domain: ROUTE_DNS.domain, configured: true, zones: ZONES, ...dns },
  values: valeurs,
});

test('chaque route porte son propre bouton DNS', () => {
  // Deux routes d'un meme Spark ont deux domaines : un bouton de SECTION ne
  // saurait pas lequel pointer.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS, { ...ROUTE_DNS, domain: 'autre.lelabs.tech' }]);
  assert.equal((rendu.match(/data-dns-route=/g) ?? []).length, 2);
  assert.ok(rendu.includes('data-dns-route="test.spark.lelabs.tech"'));
});

test('la zone la plus SPECIFIQUE est retenue, pas la premiere trouvee', () => {
  // Ecrire « app.staging » dans la zone parente le rendrait invisible : la
  // delegation renvoie a la zone fille (§38.5).
  assert.equal(zonePour('app.staging.lelabs.tech', ZONES), 'staging.lelabs.tech');
  assert.equal(zonePour('test.spark.lelabs.tech', ZONES), 'lelabs.tech');
  assert.equal(zonePour('app.autre.tech', ZONES), '');
  // REVISE le 2026-08-20 : l'apex EST desormais pre-choisi. Le refus d'ecrire a
  // l'apex ayant ete leve (§38.5.1), ne pas pre-choisir la zone d'un site sur le
  // domaine nu obligeait a la chercher a la main dans une liste de quatorze —
  // pour une seule reponse possible. Mesure sur le compte reel.
  assert.equal(zonePour('lelabs.tech', ZONES), 'lelabs.tech');
});

test('le domaine de la modale est en LECTURE SEULE et vient de la route', () => {
  // Le rendre saisissable laisserait pointer un domaine que la Forge ne route
  // pas, donc un domaine qui resoudrait vers un 404.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi());
  const champ = rendu.slice(rendu.indexOf('id="dns-domaine"'));
  assert.ok(champ.slice(0, 200).includes('readonly'));
  assert.ok(rendu.includes('value="test.spark.lelabs.tech"'));
});

test('la modale montre ce qui SERA ecrit, nom relatif compris', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS],
    dnsUi({}, { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' }));
  assert.ok(rendu.includes('Sera écrit'));
  assert.ok(rendu.includes('test.spark'), 'le nom RELATIF a la zone');
  assert.ok(rendu.includes('203.0.113.7'));
  assert.ok(rendu.includes('TTL 300'));
  assert.ok(rendu.includes('Rien d’autre n’est touché dans la zone'));
});

test('une adresse IPv6 annonce un AAAA', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS],
    dnsUi({}, { dns_zone: 'lelabs.tech', dns_address: '2001:bc8:1200::1' }));
  assert.ok(/AAAA\s*\n?\s*→/.test(rendu) || rendu.includes('AAAA'));
});

test('sans jeton, la modale DIT que rien n’est configure et ne montre aucun champ', () => {
  // Une absence de configuration n'est pas une panne : l'ecran doit le dire, et
  // ne pas offrir une saisie qui ne pourrait aboutir (§38.1).
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS],
    dnsUi({ configured: false, reason: 'Aucun jeton DNS sur ce poste.', zones: [] }));
  assert.ok(rendu.includes('Aucun jeton DNS sur ce poste.'));
  assert.ok(!rendu.includes('id="dns-zone"'));
  assert.ok(rendu.includes('jamais sur la Forge'));
});

test('un compte sans zone est NOMME, pas rendu par une liste vide', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({ zones: [] }));
  assert.ok(rendu.includes('aucune zone DNS'));
});

test('la lecture des zones a son etat, distinct de l’absence de jeton', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS],
    dnsUi({ loading: true, configured: null, zones: [] }));
  assert.ok(rendu.includes('Lecture des zones'));
  assert.ok(!rendu.includes('Aucun jeton'));
});

test('ce qui est ECRIT est annonce avec sa propagation, jamais comme « pret »', () => {
  // §38.4 : annoncer « pret » ferait chercher la panne ailleurs pendant toute
  // la duree du TTL.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], ui({
    dns: { ...ADMIN_VIDE.dns, written: {
      type: 'A', fqdn: 'test.spark.lelabs.tech', data: '203.0.113.7',
      propagation: 'Enregistrement écrit. La résolution peut demander jusqu’à 300 secondes.',
    } },
  }));
  assert.ok(rendu.includes('test.spark.lelabs.tech'));
  assert.ok(rendu.includes('écrit chez le fournisseur'));
  assert.ok(rendu.includes('id="dns-ecrit"'),
    'l’annonce d’écriture doit se distinguer de l’avertissement de remplacement');
  assert.ok(rendu.includes('300 secondes'));
  assert.ok(!/domaine (est )?prêt|résout désormais/i.test(rendu));
});

test('un refus du fournisseur s’affiche DANS la modale, sans effacer la saisie', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], ui({
    open: 'dns',
    dns: { ...ADMIN_VIDE.dns, domain: ROUTE_DNS.domain, configured: true, zones: ZONES },
    refusal: { panel: 'dns', message: 'Le fournisseur DNS a refusé (HTTP 403).' },
    values: { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' },
  }));
  assert.ok(rendu.includes('Le fournisseur DNS a refusé (HTTP 403).'));
  assert.ok(rendu.includes('203.0.113.7'), 'la saisie survit au refus (§26.2)');
});

// --- ce qui est deja la (SPK-47 revise, docs/DAT.md §38.5.2) ---------------

test('un remplacement MONTRE la valeur remplacee, pas seulement son existence', () => {
  // §38.5.2 : c'est ce qui remplace le refus d'ecrire a l'apex. On ne retire pas
  // le pouvoir, on montre ce qu'il va faire.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({
    apercu: { effet: 'remplace', apex: false, data: '203.0.113.7',
              current: { data: '198.51.100.1', type: 'A' } },
  }, { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' }));
  assert.ok(rendu.includes('198.51.100.1'), 'la valeur REMPLACEE doit etre lisible');
  assert.ok(rendu.includes('remplacé'));
});

test('un remplacement a l’APEX dit que c’est le domaine NU', () => {
  // Ecraser le nom nu deplace tout ce qui repond sur le domaine, pas un
  // sous-domaine : le geste est permis, il n'est pas anodin (§38.5.1).
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({
    apercu: { effet: 'remplace', apex: true, data: '203.0.113.7',
              current: { data: '198.51.100.1', type: 'A' } },
  }, { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' }));
  assert.ok(/domaine <strong>nu<\/strong>/.test(rendu));
});

test('une valeur DEJA en place le dit, et n’alarme pas', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({
    apercu: { effet: 'inchange', apex: false, data: '203.0.113.7',
              current: { data: '203.0.113.7', type: 'A' } },
  }, { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' }));
  assert.ok(rendu.includes('ne changera rien'));
  assert.ok(!rendu.includes('avertissement'), 'rien a signaler n’est pas un avertissement');
});

test('une pose sur un nom libre le dit', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({
    apercu: { effet: 'pose', apex: false, data: '203.0.113.7', current: null },
  }, { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' }));
  assert.ok(rendu.includes('Rien n’occupe ce nom'));
});

test('tant que la lecture n’a pas eu lieu, l’ecran ne PRETEND rien', () => {
  // Ne pas avoir lu n'est pas « rien n'est la » : afficher « sera pose » avant
  // d'avoir lu serait affirmer ce qu'on ne sait pas (§33.3).
  const enCours = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({ apercuEnCours: true }));
  assert.ok(enCours.includes('Lecture de ce qui est déjà en place'));

  const rien = renderRoutesPanel(SPARK, [ROUTE_DNS], dnsUi({ apercu: null }));
  assert.ok(!rien.includes('Rien n’occupe ce nom'));
  assert.ok(!rien.includes('remplacé'));
});

test('l’apercu de l’APEX s’ecrit « @ », pas un tiret', () => {
  // Un tiret se lit « rien » la ou il faut lire « le domaine lui-meme ».
  const rendu = renderRoutesPanel(SPARK, [{ ...ROUTE_DNS, domain: 'lelabs.tech' }], ui({
    open: 'dns',
    dns: { ...ADMIN_VIDE.dns, domain: 'lelabs.tech', configured: true, zones: ZONES },
    values: { dns_zone: 'lelabs.tech', dns_address: '203.0.113.7' },
  }));
  assert.ok(rendu.includes('@ A'), 'la notation des fichiers de zone');
  assert.ok(!rendu.includes('— A'));
});

// --- le joker et la surcharge (SPK-48, docs/DAT.md §18.3 bis) --------------

const JOKER = { domain: '*.monapi.fr', target_port: 8080, tls: true,
                applied_at: '2026-08-20T09:00:00',
                superseded_by: [{ domain: 'api.monapi.fr', spark_name: 'dedie' }] };

test('un joker MONTRE les noms qui lui sont soustraits, et qui les sert', () => {
  // Sans cette liste, un exploitant qui constate qu'un sous-domaine ne repond
  // pas comme les autres cherche dans la configuration du Spark porteur, ou il
  // n'y a rien a trouver.
  const rendu = renderRoutesPanel(SPARK, [JOKER]);
  assert.ok(rendu.includes('*.monapi.fr'));
  assert.ok(rendu.includes('api.monapi.fr'));
  assert.ok(rendu.includes('dedie'));
  assert.ok(rendu.includes('est servi par le'));
});

test('un joker SANS surcharge n’affiche aucune liste', () => {
  const rendu = renderRoutesPanel(SPARK, [{ ...JOKER, superseded_by: [] }]);
  assert.ok(!rendu.includes('surcharges'));
});

test('une route exacte, qui ne porte pas la cle, ne fait rien apparaitre', () => {
  // §14.7 : une valeur absente ne doit jamais devenir « undefined » a l'ecran.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS]);
  assert.ok(!rendu.includes('undefined'));
  assert.ok(!rendu.includes('surcharges'));
});

test('la liste est IMBRIQUEE sous la route, pas un badge', () => {
  // §14.8 : deux natures differentes se distinguent par la STRUCTURE et pas
  // seulement par la couleur.
  const rendu = renderRoutesPanel(SPARK, [JOKER]);
  assert.ok(/<ul class="surcharges">/.test(rendu));
  assert.ok(!/badge[^"]*">[^<]*api\.monapi\.fr/.test(rendu));
});

test('la prise de pas s’annonce apres une declaration reussie', () => {
  // La declaration a REUSSI : accent, pas danger. Mais le silence produirait une
  // panne cherchee pendant des heures du mauvais cote.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], ui({
    supersedes: { domain: '*.monapi.fr', spark_name: 'general' },
  }));
  assert.ok(rendu.includes('prend'));
  assert.ok(rendu.includes('*.monapi.fr'));
  assert.ok(rendu.includes('general'));
  assert.ok(rendu.includes('id="prise-de-pas"'));
  assert.ok(!rendu.includes('class="refus"'), 'ce n’est pas un refus');
});

test('sans prise de pas, rien ne s’affiche', () => {
  assert.ok(!renderRoutesPanel(SPARK, [ROUTE_DNS]).includes('prise-de-pas'));
});

// --- les ports publiés (SPK-49, docs/DAT.md §39) ---------------------------

const PORT = { public_port: 2525, target_port: 25, protocol: 'tcp',
               note: 'SMTP entrant', applied_at: '2026-08-20T09:00:00' };
const RESERVES = [{ port: 22, reason: 'le sshd de la Forge, seule porte du système' },
                  { port: 443, reason: 'le proxy, qui sert les routes publiques en TLS' }];

test('un port publie se lit avec sa cible, son protocole et sa raison d’etre', () => {
  const rendu = renderPortsPanel(SPARK, [PORT]);
  assert.ok(rendu.includes('2525/tcp'));
  assert.ok(rendu.includes('port 25 du Spark'));
  assert.ok(rendu.includes('SMTP entrant'));
});

test('l’absence de port est NOMMEE, pas rendue par un tableau vide', () => {
  assert.ok(renderPortsPanel(SPARK, []).includes('Aucun port de la Forge'));
});

test('un port NON APPLIQUE se voit — accent, pas danger', () => {
  // C'est un retard, pas une panne : le §18.5 transpose au §39.5.
  const rendu = renderPortsPanel(SPARK, [{ ...PORT, applied_at: null }]);
  assert.ok(rendu.includes('non appliqué'));
  assert.ok(rendu.includes('badge--accent'));
  assert.ok(!rendu.includes('badge--danger'));
});

test('la modale DIT ce que le port fait perdre, et vers quoi se rabattre', () => {
  // §39.3 : publier un port pour une application qui parle HTTP est presque
  // toujours une erreur — on perd le certificat sans rien gagner. Le produit ne
  // l'interdit pas, il le dit.
  const rendu = renderPortsPanel(SPARK, [], ui({ open: 'port' }));
  assert.ok(rendu.includes('perd le'));
  assert.ok(rendu.includes('certificat automatique'));
  assert.ok(rendu.includes('route publique'));
  assert.ok(/messagerie|base de données/.test(rendu));
});

test('la modale ENUMERE les ports reserves et la raison de chacun', () => {
  // « réservé » seul laisserait chercher pourquoi, et un exploitant qui ne sait
  // pas ce qui occupe 443 essaiera de le libérer (§39.5).
  const rendu = renderPortsPanel(SPARK, [], ui({ open: 'port' }), RESERVES);
  assert.ok(rendu.includes('443'));
  assert.ok(rendu.includes('proxy'));
  assert.ok(rendu.includes('sshd'));
});

test('un port de la Forge est annonce comme une ressource de la MACHINE', () => {
  const rendu = renderPortsPanel(SPARK, [], ui({ open: 'port' }));
  assert.ok(rendu.includes('machine'));
  assert.ok(rendu.includes('premier qui le prend'));
});

test('le retrait d’un port se CONFIRME, en nommant le port et l’effet', () => {
  const rendu = renderPortsPanel(SPARK, [PORT],
    ui({ confirming: { kind: 'port', id: '2525' } }));
  assert.ok(rendu.includes('Retirer le port 2525 ?'));
  assert.ok(rendu.includes('cessera d’être joignable'));
  assert.ok(rendu.includes('bouton--destructif'));
});

test('un refus du serveur s’affiche DANS la modale du port', () => {
  const rendu = renderPortsPanel(SPARK, [], ui({
    open: 'port', refusal: { panel: 'port', message: 'Le port 443 est tenu par le proxy.' },
  }));
  assert.ok(rendu.includes('Le port 443 est tenu par le proxy.'));
});

// --- les recettes DNS (SPK-50, docs/DAT.md §38.6) --------------------------

const CATALOGUE = [{
  id: 'site-web', label: 'Site web sur le domaine nu',
  description: 'Fait répondre le domaine lui-même et son « www ».',
  parametres: [{ nom: 'domain', label: 'Domaine', aide: 'Le domaine nu.' },
               { nom: 'address', label: 'Adresse publique de la Forge' }],
  actionsHumaines: [],
}, {
  id: 'relais-transactionnel', label: 'Émission par le relais',
  description: 'ATTENTION : ce sous-domaine ÉMET et NE REÇOIT PAS.',
  parametres: [{ nom: 'domain', label: 'Sous-domaine émetteur' },
               { nom: 'dkim', label: 'Clé publique DKIM', facultatif: true,
                 aide: 'À LIRE dans la console du fournisseur.' }],
  actionsHumaines: ['Le DNS inverse (PTR) ne vit pas dans la zone.'],
}];
const recetteUi = (recettes = {}, valeurs = {}) => ui({
  open: 'recette',
  recettes: { ...ADMIN_VIDE.recettes, catalogue: CATALOGUE,
              zones: [{ zone: 'exemple.tech' }], ...recettes },
  values: valeurs,
});

test('la modale enumere les recettes et decrit celle qui est choisie', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({}, { recette: 'relais-transactionnel' }));
  assert.ok(rendu.includes('Site web sur le domaine nu'));
  assert.ok(rendu.includes('ÉMET et NE REÇOIT PAS'),
    'l’avertissement de la recette doit etre lisible AVANT de l’appliquer');
});

test('les parametres SUIVENT la recette choisie', () => {
  const web = renderRoutesPanel(SPARK, [], recetteUi({}, { recette: 'site-web' }));
  assert.ok(web.includes('data-param="address"'));
  assert.ok(!web.includes('data-param="dkim"'));

  const relais = renderRoutesPanel(SPARK, [], recetteUi({}, { recette: 'relais-transactionnel' }));
  assert.ok(relais.includes('data-param="dkim"'));
  assert.ok(relais.includes('(facultatif)'));
  assert.ok(relais.includes('console du fournisseur'), 'l’aide doit dire OU lire la cle');
});

test('les actions HUMAINES restantes sont montrees avec la recette', () => {
  // §38.7 : le produit fait sa part et dit precisement ou s'arrete son pouvoir.
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({}, { recette: 'relais-transactionnel' }));
  assert.ok(rendu.includes('ne peut pas faire'));
  assert.ok(rendu.includes('PTR'));
});

test('l’apercu montre CHAQUE ligne, son role et son effet', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({
    apercu: { label: 'Site web', incomplete: null, records: [
      { name: '', type: 'A', data: '203.0.113.7', role: 'Le domaine lui-même.',
        effet: 'remplace', current: { data: '198.51.100.1' } },
      { name: 'www', type: 'A', data: '203.0.113.7', role: 'Le « www ».', effet: 'pose' },
    ] },
  }, { recette: 'site-web', recette_zone: 'exemple.tech' }));
  assert.ok(rendu.includes('@ A'), 'l’apex se note « @ »');
  assert.ok(rendu.includes('Le domaine lui-même.'));
  // §38.6.4 ter : l'etat prend un badge, aux memes places dans les trois blocs.
  assert.ok(rendu.includes('remplace 198.51.100.1'),
    'la valeur remplacee doit etre LUE dans l’etat');
  assert.ok(rendu.includes('à poser'));
  assert.ok(rendu.includes('recette-ligne__etat'));
});

test('l’apercu montre les ROUTES avant les enregistrements (§38.6.4 bis)', () => {
  // L'ordre affiche est l'ordre REEL : la route d'abord, le DNS ensuite. Montrer
  // l'inverse ferait mal lire un echec.
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({
    apercu: { label: 'Site web', incomplete: null,
      routes: [{ domain: 'exemple.tech', port: 8080, role: 'Le domaine nu.',
                 etat: 'poser' }],
      records: [{ name: '', type: 'A', data: '203.0.113.7', role: 'Le domaine.',
                  effet: 'pose' }] },
  }, { recette: 'site-web', recette_zone: 'exemple.tech' }));
  assert.ok(rendu.includes('route exemple.tech'));
  assert.ok(rendu.includes('port 8080'));
  assert.ok(rendu.includes('à déclarer'));
  assert.ok(rendu.indexOf('route exemple.tech') < rendu.indexOf('@ A'),
    'la route se lit AVANT l’enregistrement');
});

test('une route deja tenue par un AUTRE Spark est nommee comme telle', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({
    apercu: { label: 'Site web', incomplete: null,
      routes: [{ domain: 'exemple.tech', port: 8080, role: 'Le domaine nu.',
                 etat: 'occupee', spark: 'vitrine' }],
      records: [] },
  }, { recette: 'site-web', recette_zone: 'exemple.tech' }));
  assert.ok(rendu.includes('tenue par vitrine'));
});

test('une route DEJA en place vers le meme Spark n’est pas un refus', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({
    apercu: { label: 'Site web', incomplete: null,
      routes: [{ domain: 'exemple.tech', port: 8080, role: 'Le domaine nu.',
                 etat: 'deja' }],
      records: [] },
  }, { recette: 'site-web', recette_zone: 'exemple.tech' }));
  assert.ok(rendu.includes('déjà en place'));
  assert.ok(!rendu.includes('badge--danger'), 'un etat atteint n’est pas un echec');
});

test('une recette INCOMPLETE le dit des l’apercu', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({
    apercu: { label: 'Relais', records: [],
              incomplete: 'La clé DKIM n’a pas été fournie : SANS SIGNATURE.' },
  }, { recette: 'relais-transactionnel', recette_zone: 'exemple.tech' }));
  assert.ok(rendu.includes('SANS SIGNATURE'));
});

test('le compte rendu rend le sort de CHAQUE ligne, jamais un verdict global', () => {
  // §38.6.3 : un « succes » sur une recette a moitie posee serait le pire des
  // mensonges possibles ici. DESIGN_SYSTEM §6.13 : « resultat partiel » est un
  // etat a traiter.
  const rendu = renderRoutesPanel(SPARK, [], ui({
    recettes: { ...ADMIN_VIDE.recettes, resultat: {
      label: 'Site web', written: 1, failed: 1,
      incomplete: 'Recette incomplète : A www n’a pas été écrit.',
      propagation: 'La résolution peut demander jusqu’à 300 secondes.',
      records: [{ name: '', type: 'A', written: true },
                { name: 'www', type: 'A', written: false, error: 'HTTP 429' }],
    } },
  }));
  assert.ok(rendu.includes('1 écrit(s), 1 en échec'));
  assert.ok(rendu.includes('HTTP 429'));
  assert.ok(rendu.includes('Recette incomplète'));
  assert.ok(rendu.includes('avertissement'), 'un resultat partiel s’annonce en accent');
});

test('une recette ENTIEREMENT ecrite n’est pas presentee comme un avertissement', () => {
  const rendu = renderRoutesPanel(SPARK, [], ui({
    recettes: { ...ADMIN_VIDE.recettes, resultat: {
      label: 'Site web', written: 2, failed: 0, incomplete: null,
      propagation: 'La résolution peut demander jusqu’à 300 secondes.',
      records: [{ name: '', type: 'A', written: true },
                { name: 'www', type: 'A', written: true }],
    } },
  }));
  assert.ok(rendu.includes('2 écrit(s)'));
  assert.ok(!rendu.includes('en échec'));
});

test('tant que la lecture n’a pas eu lieu, l’apercu ne PRETEND rien', () => {
  // `lu` porte la demande en cours : un apercu qui se lit en a TOUJOURS une.
  const enCours = renderRoutesPanel(SPARK, [],
    recetteUi({ chargement: true, lu: 'site-web|exemple.tech|{}' }));
  assert.ok(enCours.includes('Lecture de ce qui est déjà en place'));
  const rien = renderRoutesPanel(SPARK, [], recetteUi());
  assert.ok(!rien.includes('Sera écrit'));
});

test('la lecture des ZONES ne se fait pas passer pour celle de l’apercu', () => {
  // §38.1.1 : les deux lectures portent le meme drapeau `chargement`. Sans
  // garde, la modale annoncait « lecture de ce qui est deja en place » avant
  // meme qu'une zone soit choisie — et le disait en double, le champ « Zone »
  // annoncant deja la sienne.
  const rendu = renderRoutesPanel(SPARK, [],
    recetteUi({ zones: [], chargement: true, lu: null }));
  assert.ok(rendu.includes('Lecture des zones du compte'));
  assert.ok(!rendu.includes('Lecture de ce qui est déjà en place'),
    'une seule lecture est en cours, et l’ecran n’en annonce qu’une');
});

// --- un port n'est PAS un curseur (SPK-59, DESIGN_SYSTEM.md §6.9 bis) -------

test('les ports publies restent des SAISIES, jamais des curseurs', () => {
  // Contre-exemple du §6.9 bis : bornes connues, mais 65 534 crans a l'unite et
  // aucun arrondi possible. Un port se recopie, il ne se fait pas glisser.
  const html = renderPortsPanel(SPARK, [], ui({ open: 'port' }));
  assert.equal(/<input[^>]*type="range"/.test(html), false);
  assert.match(html, /<input[^>]*id="port-public"[^>]*type="number"[^>]*max="65535"/);
});

test('le fragment SSH dit pourquoi il porte un rebond, et renvoie (§1.5 bis)', () => {
  // Le fait QUALIFIE le fragment affiché : sans lui, le « ProxyJump » se lit
  // comme une bizarrerie. C'est le « mot juste » que le §1.5 bis conserve, et
  // le renvoi mène à l'explication au lieu de la recopier.
  const rendu = renderKeysPanel(SPARK,
    { keys: [CLE], sshConfig: { config: 'Host crm\n  ProxyJump forge' } }, ui());
  assert.match(rendu, /n’expose jamais son port 22/);
  assert.match(rendu, /href="#\/manuel\/M6"/);
});

// --- LE VIDE DIT SA RAISON (SPK-47/SPK-50 revises, docs/DAT.md §38.1.1) -----
// Mesure le 2026-09-02 : la cle du poste avait EXPIRE, le fournisseur refusait,
// et le selecteur de zones restait vide SANS un mot. Une liste vide n'est pas
// une reponse.

test('un refus du fournisseur est lu comme tel, pas comme une absence de zones', () => {
  // Le corps d'un 502 ne porte PAS de champ `configured` : c'est exactement ce
  // qu'un `configured === false` laissait passer.
  assert.equal(
    refusZones({ error: 'dns_unavailable',
                 message: 'Le fournisseur DNS a refusé (HTTP 401) : expired' }),
    'Le fournisseur DNS a refusé (HTTP 401) : expired');
});

test('un poste sans jeton garde sa raison propre', () => {
  assert.equal(refusZones({ configured: false, reason: 'Aucun jeton DNS sur ce poste.' }),
    'Aucun jeton DNS sur ce poste.');
});

test('un compte qui n’a REELLEMENT aucune zone n’est pas un refus', () => {
  assert.equal(refusZones({ configured: true, zones: [] }), null);
  assert.equal(refusZones(null), null);
});

test('le selecteur de zones vide PORTE la raison de son vide', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi(
    { zones: [], zonesRefus: 'Le fournisseur DNS a refusé (HTTP 401) : expired' },
    { recette: 'site-web' }));
  assert.ok(rendu.includes('id="recette-zones-vides"'));
  assert.ok(rendu.includes('HTTP 401'), 'le message du fournisseur est rendu TEL QUEL');
  assert.ok(rendu.includes('aria-describedby="recette-zones-vides"'),
    'le champ doit decrire son propre vide');
});

test('un compte sans zone le DIT, et ne prend pas la couleur du refus', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({ zones: [] }, { recette: 'site-web' }));
  assert.ok(rendu.includes('ne porte aucune zone DNS'));
  assert.ok(!rendu.includes('champ__erreur'), 'un fait n’est pas une erreur');
});

test('tant qu’on lit les zones, l’ecran ne conclut PAS a leur absence', () => {
  const rendu = renderRoutesPanel(SPARK, [],
    recetteUi({ zones: [], chargement: true }, { recette: 'site-web' }));
  assert.ok(rendu.includes('Lecture des zones du compte'));
  assert.ok(!rendu.includes('ne porte aucune zone DNS'));
});

test('la raison du vide SURVIT a la remise a zero de l’apercu', () => {
  // C'est le coeur du defaut : `erreur` est remise a null avant chaque
  // relecture d'apercu. Une raison logee la disparaissait au premier
  // changement de recette, et le selecteur redevenait vide et muet.
  const rendu = renderRoutesPanel(SPARK, [], recetteUi(
    { zones: [], zonesRefus: 'Le fournisseur DNS a refusé (HTTP 401) : expired',
      erreur: null, apercu: null },
    { recette: 'site-web' }));
  assert.ok(rendu.includes('HTTP 401'));
});

test('un refus du fournisseur n’envoie PAS poser un jeton qui est deja la', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_DNS], ui({
    open: 'dns',
    dns: { ...ADMIN_VIDE.dns, domain: ROUTE_DNS.domain, configured: null, zones: [],
           refus: 'Le fournisseur DNS a refusé (HTTP 401) : expired' },
  }));
  assert.ok(rendu.includes('id="dns-refus"'));
  assert.ok(rendu.includes('HTTP 401'));
  assert.ok(!rendu.includes('Le jeton vit sur ce poste'),
    'conseiller de poser un jeton enverrait chercher au mauvais endroit');
  assert.ok(!rendu.includes('ne porte aucune zone DNS'),
    'un refus n’est pas un compte vide');
});

// --- SPK-78 · L'ETAT DNS D'UNE ROUTE, ET LA VERIFICATION (§38.9) -----------

test('tant que rien n’est relevé, la route n’affiche AUCUN etat', () => {
  // « pas encore su » n'est pas « aucun enregistrement » : afficher un etat
  // avant la lecture ferait croire a un fait mesure.
  assert.equal(renderEtatDns({ etats: {} }, 'crm.exemple.tech'), '');
  assert.equal(renderEtatDns(undefined, 'crm.exemple.tech'), '');
});

test('les quatre etats DNS d’une route se distinguent, et nomment ce qu’ils savent', () => {
  const etats = {
    'a.exemple.tech': { domain: 'a.exemple.tech', etat: 'ici' },
    'b.exemple.tech': { domain: 'b.exemple.tech', etat: 'ailleurs', data: '198.51.100.9' },
    'c.exemple.tech': { domain: 'c.exemple.tech', etat: 'absent', zone: 'exemple.tech' },
    'd.autre.fr': { domain: 'd.autre.fr', etat: 'hors-zone' },
  };
  assert.match(renderEtatDns({ etats }, 'a.exemple.tech'), /DNS ici/);
  const ailleurs = renderEtatDns({ etats }, 'b.exemple.tech');
  assert.match(ailleurs, /198\.51\.100\.9/, 'pointer ailleurs SANS dire ou n’apprend rien');
  assert.match(ailleurs, /badge--danger/, 'le trafic n’arrive pas ici : c’est un defaut');
  assert.match(renderEtatDns({ etats }, 'c.exemple.tech'), /Aucun enregistrement/);
  const dehors = renderEtatDns({ etats }, 'd.autre.fr');
  assert.match(dehors, /hors du compte/);
  assert.ok(!/Aucun enregistrement/.test(dehors),
    'un nom dont la zone est ailleurs n’est pas un oubli');
});

test('la casse d’un domaine ne fait pas perdre son etat', () => {
  const etats = { 'crm.exemple.tech': { domain: 'crm.exemple.tech', etat: 'ici' } };
  assert.match(renderEtatDns({ etats }, 'CRM.Exemple.tech'), /DNS ici/);
});

test('la verification dit ce que la zone PORTE, sans promettre la resolution', () => {
  const rendu = renderVerification({ verification: [
    { name: 'www', type: 'A', etat: 'conforme' },
    { name: '', type: 'A', etat: 'different', trouve: '198.51.100.9' },
    { name: 'vieux', type: 'A', etat: 'absent' },
  ] });
  assert.ok(rendu.includes('des écarts subsistent'));
  assert.ok(rendu.includes('198.51.100.9'), 'la valeur trouvee est NOMMEE');
  assert.ok(rendu.includes('@ A'), 'l’apex se note « @ »');
  assert.ok(rendu.includes('TTL'), '§38.9.2 : conforme ne veut pas dire resolu');
  assert.ok(!/en ligne|résout|prêt/i.test(rendu));
});

test('une verification SANS ecart n’est pas presentee comme un avertissement', () => {
  const rendu = renderVerification({ verification: [
    { name: 'www', type: 'A', etat: 'conforme' }] });
  assert.ok(rendu.includes('chaque ligne est en place'));
  assert.ok(!rendu.includes('avertissement'));
});

test('une relecture IMPOSSIBLE le dit, et ne conclut pas a la conformite', () => {
  const rendu = renderVerification({
    verificationErreur: 'Le fournisseur DNS a refusé (HTTP 401) : expired' });
  assert.ok(rendu.includes('HTTP 401'));
  assert.ok(!/conforme|en place/.test(rendu));
});

test('tant que la relecture court, l’ecran ne conclut RIEN', () => {
  const rendu = renderVerification({ verifieEnCours: true });
  assert.ok(rendu.includes('Relecture de la zone'));
  assert.ok(!/conforme|absent/.test(rendu));
});

// --- SPK-89 · CORRIGER LA CIBLE D'UNE ROUTE (docs/DAT.md §18.3 ter) --------

const ROUTE_A_CORRIGER = { domain: 'crm.exemple.tech', target_port: 8080, tls: 1,
                           applied_at: '2026-09-02T10:00' };

test('chaque route offre de CORRIGER sa cible', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_A_CORRIGER], ui());
  assert.ok(rendu.includes('data-modifie-route="crm.exemple.tech"'));
});

test('la correction porte le port et le TLS, JAMAIS le domaine', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_A_CORRIGER], ui({
    editing: 'crm.exemple.tech',
    values: { route_port: 8080, route_tls: true } }));
  assert.ok(rendu.includes('id="route-edition"'));
  assert.ok(rendu.includes('id="edit-port"'));
  assert.ok(rendu.includes('id="edit-tls"'));
  // Le domaine est MONTRE et non saisissable : le changer ne serait pas une
  // correction mais une autre route.
  assert.ok(/id="edit-domaine"[^>]*readonly/.test(rendu));
  assert.ok(/ne se corrige\s+pas/.test(rendu));
  // Le Spark n'y figure pas du tout : ce geste-la se fait en retirant et en
  // declarant, pour qu'il se voie dans le journal des DEUX.
  assert.ok(!rendu.includes('id="edit-spark"'));
});

test('la correction ANNONCE que la route redevient non appliquee', () => {
  // §18.5 : un succes annonce avant la reprise de Caddy ferait chercher la
  // panne du mauvais cote.
  const rendu = renderRoutesPanel(SPARK, [ROUTE_A_CORRIGER], ui({
    editing: 'crm.exemple.tech', values: { route_port: 9000, route_tls: true } }));
  assert.ok(/non appliquée/.test(rendu));
});

test('un refus de la correction s’affiche DANS sa modale', () => {
  const rendu = renderRoutesPanel(SPARK, [ROUTE_A_CORRIGER], ui({
    editing: 'crm.exemple.tech',
    values: { route_port: 9000, route_tls: true },
    refusal: { panel: 'route-edition', message: '« crm » est protégé.' } }));
  assert.ok(rendu.includes('« crm » est protégé.'));
  assert.ok(rendu.includes('value="9000"'), 'la saisie survit au refus');
});

// --- SPK-88 · LE PORT D'UNE RECETTE (docs/DAT.md §38.6.4 bis) --------------

test('un parametre de PORT se saisit comme un port, avec ses bornes', () => {
  const rendu = renderRoutesPanel(SPARK, [], recetteUi({
    catalogue: [{ id: 'site-web', label: 'Site web', description: 'x',
                  parametres: [{ nom: 'port', label: 'Port du Spark', port: true,
                                 defaut: '8080' }],
                  actionsHumaines: [] }],
  }, { recette: 'site-web', recette_zone: 'exemple.tech' }));
  assert.ok(/data-param="port"[^>]*type="number"/.test(rendu));
  assert.ok(/max="65535"/.test(rendu));
});

test('ecrire une recette a routes SANS apercu est refuse, et le DIT', () => {
  // §38.6.4 bis : sans apercu, on n'ecrirait que le DNS — donc un nom qui pointe
  // vers une Forge qui ne le sert pas. C'est l'ordre que la regle refuse.
  const catalogue = [{ id: 'site-web', label: 'Site web', poseDesRoutes: true }];
  const refus = refusEcritureRecette({ catalogue, apercu: null },
                                     { recette: 'site-web', recette_zone: 'exemple.tech' });
  assert.match(refus, /déclare des routes/);
  assert.match(refus, /ne le\s+sert pas/);
});

test('une recette SANS route n’exige pas d’apercu', () => {
  const catalogue = [{ id: 'relais', label: 'Relais', poseDesRoutes: false }];
  assert.equal(refusEcritureRecette({ catalogue, apercu: null },
                                    { recette: 'relais', recette_zone: 'exemple.tech' }), null);
});

test('l’apercu present leve la garde', () => {
  const catalogue = [{ id: 'site-web', label: 'Site web', poseDesRoutes: true }];
  assert.equal(refusEcritureRecette({ catalogue, apercu: { records: [], routes: [] } },
                                    { recette: 'site-web', recette_zone: 'exemple.tech' }), null);
});
