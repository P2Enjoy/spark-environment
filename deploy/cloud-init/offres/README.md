# Les offres de l'hébergeur, et ce qu'on en tire pour la Forge

@spec docs/BACKLOG.md#SPK-158 (points 6 et 7) · docs/DAT.md §66.7 (les offres relevées
sont versionnées), §66.8 (le pool est déclaré à l'hébergeur ; le JSON de partition est
versionné, le cloud-init ne l'est pas), §66.2 et §66.3 (la commande et sa règle) ·
README.md (« Commander une Forge »)

## Refaire un serveur d'une config connue

**Le JSON de partition** est versionné, prêt à coller dans l'éditeur de partitions de la
console (*Custom configuration*) :

| Offre | Relevée le | JSON de partition à coller |
|---|---|---|
| EM-L101X-SATA | 2026-11-10 | [`forge/EM-L101X-SATA.partitionnement.json`](forge/EM-L101X-SATA.partitionnement.json) |
| EM-B311X-SATA | 2026-11-16 | [`forge/EM-B311X-SATA.partitionnement.json`](forge/EM-B311X-SATA.partitionnement.json) |

**Le cloud-init n'est PAS versionné**, et c'est voulu : il dépend de l'amorce
(`spark-amorce.sh`) et de `creer-pool.sh`, qui évoluent. Une copie versionnée serait en
retard sur eux et poserait une vieille amorce sur une machine neuve. Il se produit **à la
demande, depuis l'amorce courante, par le nom de l'offre**, à coller dans *Cloud-init
configuration* — **léger** (≈ 1 Ko) : il télécharge les scripts au commit épinglé et vérifie
leur sha256, parce que Scaleway a refusé un `user-data` de 19 Ko. La commande refuse tant que
les scripts locaux ne sont pas committés **et poussés** ; `--embarquer` donne un cloud-init
autonome (≈ 11 Ko) :

```bash
python3 scripts/preparer-forge.py cloud-init --offre EM-B311X-SATA
```

L'amorce garde son défaut de **16 Gio d'ARC**, réglé pour 94 Gio de RAM ; la RAM de chaque
offre n'est pas relevée. Sur une machine qui en a moins : ajouter `--arc-gib <N>`.

Le JSON de partition se reproduit de la même façon (`partitionnement --offre <NOM>`).
`python3 scripts/preparer-forge.py offres` le réécrit pour toutes les offres, et une
preuve échoue s'il n'est plus ce que la commande produit.

**Ce que contient le JSON de partition** : sur chaque disque, la partition `root` bornée à
200 Gio, puis une partition **`data`** qui prend tout le reste ; le système reste en RAID 1 ;
la section `zfs` du schéma **déclare le pool miroir `spark`** (`ashift=12`) sur les deux
partitions. Tout le reste est celui de l'offre.

**La référence : `spark-experiment`.** [`reference/`](reference/) porte le schéma par
défaut de l'offre de la Forge en service et le JSON de partition **avec lequel elle a été
installée et démarre** (relevés le 2026-11-17). Une preuve exige que la commande, appliquée
à ce défaut, reproduise ce JSON octet pour octet. Ces fichiers ne sont pas une offre : la
commande `offres` ne les lit pas.

**Si l'installateur bloque sur le pool** : le repli est le schéma sans pool déclaré, que
l'amorce complète en créant le pool :
`python3 scripts/preparer-forge.py partitionnement --offre <NOM> --sans-zfs`. Le
cloud-init est le même.

## Les schémas originaux

Un fichier par offre : le schéma de partitionnement **par défaut** que la console de
l'hébergeur affiche (*Custom configuration*, *Reset to default*), copié **tel
qu'affiché**. Ils sont l'entrée de la commande et la référence des preuves de sa règle.

| Fichier | Relevé le | Particularité |
|---|---|---|
| [`EM-L101X-SATA.json`](EM-L101X-SATA.json) | 2026-11-10 | pas de clé `zfs` |
| [`EM-B311X-SATA.json`](EM-B311X-SATA.json) | 2026-11-16 | `"zfs": null` explicite |

Les noms sont ceux que le responsable a donnés aux relevés (offres Scaleway Elastic
Metal) ; aucun n'a été déduit du contenu. Les deux schémas ont la même structure —
`/dev/sda` et `/dev/sdb`, démarrage BIOS (partition `legacy`), RAID 1 `md0` pour
`/boot` et `md1` pour `/` — et ne diffèrent que par la clé `zfs`.

**La capacité des disques n'est pas dans ces fichiers**, et elle ne se déduit pas du nom
de l'offre : la console de l'hébergeur la contrôle à la commande. Ne la notez pas ici
sans l'avoir relevée sur la console, avec la date.

## Ajouter une offre

1. Console de l'hébergeur, à la commande : *Configure disk partitions*, *Custom
   configuration*, *Reset to default*.
2. Copier le JSON affiché **tel quel** dans `<offre>.json`, nommé comme l'offre. Un
   fichier de données ne se reformate pas à la main.
3. `python3 scripts/preparer-forge.py offres` : écrit le JSON de partition dans `forge/`.
   Une offre dont le défaut sort de la règle (pas deux disques, partition `root`
   absente…) est refusée avec ses mots.
4. Ajouter une ligne à chacun des deux tableaux ci-dessus, puis committer les fichiers.

Un fichier JSON ne porte pas de commentaire : la provenance et la date vivent dans ces
tableaux, pas dans les fichiers.
