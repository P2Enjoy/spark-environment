# @spark/contract — contrat d'API partage

@spec docs/BACKLOG.md#SPK-01, docs/BACKLOG.md#SPK-17 · docs/DAT.md §10

Frontiere explicite entre les deux livrables. `sparkd` produit son OpenAPI ; ce
paquet en derive les types TypeScript que consomme la console.

Le contrat a une seule source : le runtime. La console ne redeclare jamais une
forme de donnee de son cote — deux declarations divergent toujours, et la
divergence se decouvre en production.

La generation et la detection de derive en CI sont l'unite **SPK-17**. Tant
qu'elle n'est pas livree, ce paquet n'est qu'un emplacement reserve.
