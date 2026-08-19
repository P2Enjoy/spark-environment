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

**Arbitrage attendu du responsable** : le journal d'audit doit-il rester un
enregistrement technique — auquel cas le §14.7 gagne une exception écrite — ou
la console doit-elle traduire les transitions qu'il rapporte ?
