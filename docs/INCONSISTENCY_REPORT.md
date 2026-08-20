# Registre des incohérences

Défauts constatés en travaillant, **étrangers à l'unité en cours**. Le
comportement est laissé inchangé (`CLAUDE.md` §5, CloudWorker §3.1) : ils sont
consignés avec leur mesure, pas corrigés au passage.

Une entrée résolue est **retirée** de ce fichier. Lorsqu'il devient vide, le
fichier est supprimé du dépôt.

## Ouverts

### INC-01 · Le journal d'audit affiche les états techniques, l'interface les traduit

**Constaté le** 2026-08-19, sur la capture `e2e/captures/43-reel-detail-complet.png`,
contre le runtime réel.

**Mesure.** Sur le même écran, la colonne d'état et le badge d'identité affichent
« En marche », « Arrêté », « En attente » — les libellés français du
`docs/DESIGN_SYSTEM_APP.md` SPK-DS-01. Le panneau « Journal », lui, affiche le
texte que `sparkd` a écrit dans `audit_log.message` :

```
« starting » → « running ».
« stopped » → « starting ».
« pending » → « creating ».
```

Le même concept porte donc deux vocabulaires à quelques centimètres d'écart.
`docs/DESIGN_SYSTEM.md` §14.7 demande qu'une valeur technique brute n'atteigne
pas l'écran.

**Pourquoi ce n'est pas corrigé ici.** Le texte vient du **message d'audit**, écrit
par le runtime (`sparks.finish`, `sparks.command`). Le corriger suppose de
trancher à qui appartient le vocabulaire visible : au runtime, qui écrirait des
libellés d'interface dans un journal technique, ou à la console, qui devrait
alors réécrire un message libre. C'est un arbitrage sur le contrat du §21, donc
sur SPK-15, pas sur l'unité en cours.

**Impact.** Lisibilité seulement. Aucune donnée n'est fausse, aucune décision
n'est faussée.

**Le même motif ailleurs.** Constaté le 2026-08-19 sur
`e2e/captures/09-tunnel-rompu.png` : le message d'erreur de l'hôte console dit
« Tunnel vers « validation » indisponible (**broken**, jamais joint depuis
l'ouverture) », alors que le badge et le bandeau disent maintenant « rompu ». Le
texte vient de `TunnelManager.require`, côté serveur. C'est le même arbitrage.

**Nouvelle mesure, 2026-08-19, sur l'onglet de supervision (SPK-39).** L'écart
change d'échelle, comme la DoD de SPK-39 l'annonçait. Il portait sur trois lignes
d'un panneau ; il porte maintenant sur une **page entière**, où chaque ligne du
journal expose le vocabulaire du runtime. Vu sur
`docs/manuel/images/m12-journal.png` et `e2e/captures/40-journal-supervision.png`.

L'onglet **ne réécrit aucun message** — le trancher serait l'arbitrage lui-même.
Il nomme en revanche l'écart au manuel (M12, « Une bizarrerie de vocabulaire,
connue »), pour que le lecteur ne cherche pas une erreur là où il n'y en a pas.

L'impact reste inchangé : lisibilité seulement.

**ARBITRÉ le 2026-08-20 : la console traduit à l'affichage.** Le journal reste un
enregistrement technique — il sert aussi au diagnostic, et y écrire du vocabulaire
d'interface le rendrait moins précis pour gagner en confort au mauvais endroit.
La règle est écrite au §21.5 bis du DAT.

Cette entrée **n'attend plus d'arbitrage** ; elle reste ouverte jusqu'à ce que la
traduction soit livrée, ce qui est l'objet de `docs/BACKLOG.md#SPK-46`. Elle sera
retirée d'ici dans le même changement.

### INC-03 · Un Spark dont l'instance a disparu ne peut plus être supprimé

**Constaté le 2026-08-19**, sur l'hôte, en nettoyant après la mesure de SPK-29.

**Mesure.** Un Spark passé en `error`, dont l'instance Incus a été supprimée hors
du produit, reste dans le registre :

```
POST /v1/sparks/mesure-cpu/delete  ->  502
registre après : ['mesure-cpu']
```

La suppression échoue parce que le pilote ne trouve pas l'instance, et l'entrée
reste indéfiniment. Elle continue de compter dans l'admission control et, depuis
SPK-29, **maintient le poids de la tranche** à une valeur qui ne correspond à
rien.

Un redémarrage de `sparkd` ne la retire pas : la réconciliation du §14.3 ne
traite que les états **transitoires**, et `error` est un état stable.

**Pourquoi ce n'est pas corrigé ici.** Le cycle de vie relève de SPK-09 et du §14.
Décider si `delete` doit réussir quand l'instance est déjà absente — et donc si
la disparition de l'instance vaut suppression — est un arbitrage sur ce contrat,
pas sur l'unité en cours.

**Impact.** Une ressource reste comptée pour un Spark qui n'existe plus, et le
poids de la tranche s'en trouve faussé. L'hôte de validation porte actuellement
une entrée dans ce cas.

**Arbitrage attendu du responsable** : `delete` doit-il traiter une instance déjà
absente comme un succès — la ligne disparaît, la ressource est rendue — plutôt
que comme une panne ?


### INC-04 · Deux enregistrements TXT de la zone `lelabs.tech` ne sont plus là

**Constaté le** 2026-08-20, en travaillant sur SPK-47, entre deux lectures de la
même zone au même compte.

**Mesure.** Avant toute écriture, le 2026-08-19, `GET /dns-zones/lelabs.tech/records`
rendait `total_count: 17`, et l'inventaire relevé alors portait notamment un
`TXT _dmarc.xrp-academy` et **deux** enregistrements DKIM.

Le 2026-08-20, après l'écriture du seul `test.spark A 203.0.113.7`, la même
requête rend `total_count: 16`, dont l'enregistrement qui vient d'être posé. Il
reste donc **15 enregistrements préexistants** contre 17 la veille. Manquent :

- `_dmarc.xrp-academy` TXT ;
- un des deux DKIM (celui qui ne porte pas `noreply`).

**Ce que cet écart n'explique pas, et ce qu'il faut retenir.** L'écriture du
produit est un `set` visant `{name: "test.spark", type: "A"}` : elle ne peut pas
sélectionner deux TXT dont les noms ne contiennent ni ce nom ni ce type. Le
client de la console ne possède d'ailleurs **aucune** méthode de suppression, et
un test le prouve sur sa surface publique. Les deux enregistrements manquants
partagent en revanche le même sujet — `xrp-academy` —, ce qui ressemble à un
retrait délibéré de la configuration de messagerie de ce sous-domaine.

**Ce qui a été tenté pour trancher, sans succès** :
`GET /dns-zones/lelabs.tech/versions` rend `total_count: 0` — le compte ne
conserve aucune version de la zone, donc aucun différentiel n'est consultable.

**Comportement laissé inchangé**, et rien n'a été réécrit : restaurer de mémoire
des enregistrements de messagerie serait pire que l'écart lui-même.

**Arbitrage attendu du responsable** : ces deux `TXT` ont-ils été retirés
volontairement, par vous ou par un autre outil, entre le 19 et le 20 août ? Si
la réponse est non, il faut chercher ailleurs que dans ce produit, et cet écart
doit être traité avant que le pilotage DNS ne serve sur une zone en exploitation.
