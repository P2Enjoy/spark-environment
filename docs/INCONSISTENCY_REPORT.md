# Rapport d'incohérences

Ce fichier n'existe que tant qu'une incohérence relevée n'est pas résolue ; il
est supprimé du dépôt quand il devient vide (CLAUDE.md §5).

## 2026-09-30 · « Les trois degrés s'atteignent au clavier » rouge une fois sur deux campagnes

**Constaté** en rejouant la campagne E2E pendant SPK-132 : rouge à la première
passe (148/149, en 261 ms), vert seul, puis vert à la seconde passe complète
(149/149). La capture d'échec montre `#/forge` dans l'état d'un serveur « qui
peut accepter SSH sans encore porter `sparkd` », comme si la console visait un
autre serveur de l'inventaire que la pile d'épreuve — un état qu'un parcours
antérieur aurait laissé. Le parcours s'exécute AVANT ceux de SPK-132, dont le
code ne touche ni la Forge ni la navigation.

**Arbitré le 2026-10-01** : pas de correction à part — le parcours tourne sur la
pile factice, qui ne valide plus rien (DAT §28.7). Il est absorbé par SPK-138 et
rejoué contre la VM ; l'entrée sort du rapport à ce moment.

## 2026-10-03 · Le DAT promet un rendu du gabarit d'alerte avant l'enregistrement ; l'écran n'en montre aucun

**Constaté** en spécifiant SPK-147 : le DAT §47.3.1 dit « L'écran montre le
rendu **avant** d'enregistrer, sur un événement d'exemple. Un gabarit qu'on ne
peut pas voir rendu se vérifie le jour où il sert, c'est-à-dire trop tard. »
L'onglet Alertes (`apps/webui/src/components/forge-alertes.js`) n'a aucun
rendu : il enregistre, ou montre le refus d'un champ inconnu.

**Non résolu ici** : hors du périmètre de SPK-147. À arbitrer par le
responsable : construire l'aperçu du rendu sur un événement d'exemple, ou
retirer la promesse du DAT.

## 2026-10-06 · Trois parcours rougissent en campagne et passent isolément

**Constaté** en rejouant la campagne E2E pour SPK-149, **avant et après** le
changement : « révoquer une clé malgré le gel, par la confirmation qui NOMME »,
« un conteneur ARRÊTÉ montre son code de sortie, et son silence se distingue »
et « un geste sensible envoie une alerte hors bande, un geste ordinaire non »
sont rouges dans les deux séries (148 sur 151 après ; 145 sur 149 sur l'arbre
committé, avec en plus « une page d'un autre site ne fait rien faire à la
console »), et verts tous les trois joués seuls. Le premier et le dernier sont
ceux que le journal du 2026-09-16 rattachait déjà à un ordre d'exécution. Le
second est nouveau au relevé : son écran de diagnostic, pris après l'échec,
porte bien « Code de sortie 137 » — le parcours lit `.principal` avant que
l'inspection du conteneur soit rendue, son attente s'arrêtant sur un signal
déjà vrai.

**À arbitrer** : ces parcours tournent sur la pile factice, qui ne valide rien
(DAT §28.7) ; corriger leurs attentes, ou les laisser à SPK-138 comme
l'entrée du 2026-09-30.
