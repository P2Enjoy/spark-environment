# Rapport d'incohérences

Ce fichier ne contient que des incohérences **encore ouvertes**. Une entrée
résolue en est retirée ; lorsque le fichier devient vide, il est supprimé du
dépôt (CLAUDE.md §5).

---

## I-02 · Une coupure de la surveillance hors bande qui ne s'annonce pas (SPK-62, §47.3.3)

**Mesuré le 2026-09-14** contre la pile factice, en écrivant l'OP-20 du contrat
de déploiement.

Le §47.3.3 pose une règle, et il en donne le motif : « **la désactivation NOTIFIE
par le canal qu'elle coupe**, et pendant qu'il fonctionne encore : sans quoi la
coupure serait le seul geste dont personne n'entendrait parler — et c'est le
premier qu'un attaquant tenterait. »

`PUT /v1/notify/channels` l'applique, mais seulement lorsque le canal coupé était
**celui du registre** :

```python
coupe = (avant["webhook"]["enabled"]
         and changements.get("webhook_enabled") in (0, False))
```

**Il existe un second chemin de coupure, qui n'est pas couvert.** Sur une Forge
qui veille encore par `SPARKD_NOTIFY_URL` — l'état de la production tant que
l'OP-20 n'est pas repris —, la **première écriture** depuis l'onglet appelle
`reregler()` avec ce que porte le registre. Si la case « actif » n'est pas cochée
dans cette même écriture, l'URL passée est vide : le canal devient muet, et
`avant["webhook"]["enabled"]` valant `False`, **aucun avis de coupure n'est
envoyé**.

Mesure, sur une pile démarrée avec `SPARKD_NOTIFY_URL` posée :

| Instant | `live.source` | `live.configured` |
|---|---|---|
| avant toute écriture | `environnement` | `true` |
| après `PUT` d'un gabarit seul, sans « actif » | `registre` | `false` |

La surveillance s'arrête, et c'est exactement le geste que le §47.3.3 voulait
rendre impossible à faire en silence. L'écran ne ment pas — il affiche « aucun
canal », et le §14.6 est respecté —, mais personne n'est **averti**, et c'est la
différence que le §47.3.3 tient pour décisive.

**Comportement laissé inchangé**, et l'OP-20 le nomme comme un piège de
déploiement. Deux raisons de ne pas corriger ici :

- SPK-62 est **en cours sur cette même branche dans une autre session** — son
  parcours E2E n'est pas encore committé, et il touche précisément cette route ;
- le correctif n'est pas évident et engage le produit : faut-il étendre `coupe`
  à « le canal VIVANT était configuré, quelle qu'en soit la source », ce qui
  ferait partir un avis de coupure par un canal que le registre ne connaît pas ?
  Ou refuser une écriture qui débrancherait le repli sans le remplacer ? La
  seconde est plus sûre et plus intrusive.

**Arbitrage demandé au responsable.**
