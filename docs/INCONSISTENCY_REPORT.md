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

**Arbitrage attendu du responsable** : les messages produits par le serveur —
journal d'audit, erreurs de l'hôte console — doivent-ils rester un enregistrement
technique, auquel cas le §14.7 gagne une exception écrite, ou la console
doit-elle traduire les états qu'ils rapportent ?

### INC-02 · Un refus de création n'est rattachable à aucune demande

**Constaté le** 2026-08-19, en éprouvant le seed contre le runtime réel.

**Mesure.** Un refus d'admission écrit bien au journal :

```
action    = spark.create
result    = denied
target_id = 31da918ad7146b4491007b81
message   = Capacité insuffisante — memory : 549755813888 octets demandés,
            920260608 disponibles (…) — il manque 548835553280 octets
```

Le `target_id` est l'identifiant d'un Spark **qui n'a jamais existé** : la
transaction a été annulée, aucune ligne n'a été écrite. Il ne désigne donc rien.
Et le message ne porte pas le **nom demandé**.

Conséquence : trois refus consécutifs sont indiscernables au journal. On lit
trois fois « Capacité insuffisante » sans pouvoir dire quelle demande a été
refusée, ni par qui, ni pour quel Spark.

**Pourquoi ce n'est pas corrigé ici.** Le contenu du journal d'audit relève du
§21 et de SPK-15. Décider si un refus doit porter le nom demandé — donc écrire
au journal une donnée d'une entité inexistante — est un arbitrage sur ce
contrat, pas sur l'unité en cours.

**Impact.** Diagnostic. Aucune décision automatique ne s'appuie sur ce champ.

**Arbitrage attendu du responsable** : un refus doit-il porter le nom demandé
dans son `message`, et `target_id` doit-il rester vide plutôt que de désigner un
identifiant sans objet ?

