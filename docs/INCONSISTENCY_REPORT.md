# Rapport d'incohérences

Ce fichier ne contient que des incohérences **encore ouvertes**. Une entrée
résolue en est retirée ; lorsque le fichier devient vide, il est supprimé du
dépôt (CLAUDE.md §5).

---

## I-01 · La migration `016_canaux_notification` n'a aucune opération au contrat de déploiement

**Constaté le 2026-09-14**, en écrivant l'OP-19 de SPK-104.

`services/sparkd/src/sparkd/schema/016_canaux_notification.sql` existe et est
committée (SPK-62, `3de77b2`). `docs/PROD_MIGRATIONS.md` ne la mentionne nulle
part : la dernière migration qu'il connaît est la `015`, et la baseline du §1
annonce « version de schéma 015 ».

Le §12 du `CLAUDE.md` et le §24 du DAT imposent qu'une évolution de schéma mette
à jour le contrat de déploiement **dans le même changement**. Appliquée telle
quelle, la production recevrait une table dont l'exploitant n'a ni l'objectif, ni
la vérification, ni le retour arrière écrits.

**Comportement laissé inchangé.** La correction appartient à SPK-62, qui est en
cours sur cette même branche dans une autre session — son parcours E2E n'est pas
encore committé. Écrire l'OP à sa place risquerait d'entrer en conflit avec ce
qu'elle s'apprête à écrire, et de décrire une opération dont je n'ai pas conduit
la mesure.

**Arbitrage demandé au responsable** : faire écrire l'OP manquante par la session
qui porte SPK-62, avant que cette unité ne soit déclarée close.
