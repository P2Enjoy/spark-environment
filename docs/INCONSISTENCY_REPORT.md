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

## 2026-10-01 · Un retrait de route refusé en `502` a déjà retiré la route

**Constaté** en écrivant SPK-139, en lisant `DELETE /v1/ingress/{domain}`
(`services/sparkd/src/sparkd/app.py`) : la route est retirée du **registre**,
puis l'application à Caddy échoue et la réponse est un `502` « Caddy
injoignable ». La console, qui ne relit rien après un refus (`agir`, dans
`apps/webui/src/app.js`), montre encore la route et le refus sous elle —
comme si rien n'avait été retiré. Au rechargement, la route a disparu, alors
que Caddy peut la servir encore. `DESIGN_SYSTEM.md` §6.8 : l'écran montre
l'état **relu**.

**Non résolu ici** : hors du périmètre arbitré de SPK-139, qui ne change que
l'endroit où le refus s'affiche. À arbitrer par le responsable : relire l'état
après un refus de ce geste, ou faire que le serveur ne retire la route qu'une
fois Caddy à jour — ou dire autrement qu'elle est retirée du registre mais
encore servie.
