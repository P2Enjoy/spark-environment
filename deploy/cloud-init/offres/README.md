# Schémas par défaut des offres

@spec docs/BACKLOG.md#SPK-158 (point 6) · docs/DAT.md §66.7 (les offres relevées sont
versionnées), §66.2 et §66.3 (la commande et sa règle de dérivation) · README.md
(« Commander une Forge »)

Un fichier par offre de l'hébergeur : le schéma de partitionnement **par défaut** que
sa console affiche, copié **tel qu'affiché** (*Custom configuration*, puis *Reset to
default*). Ils sont la donnée d'entrée de la commande, et la référence des preuves
de sa règle.

| Fichier | Relevé le | Particularité |
|---|---|---|
| [`EM-L101X-SATA.json`](EM-L101X-SATA.json) | 2026-11-10 | pas de clé `zfs` |
| [`EM-B311X-SATA.json`](EM-B311X-SATA.json) | 2026-11-16 | `"zfs": null` explicite |

Les noms sont ceux que le responsable a donnés aux relevés (offres Scaleway Elastic
Metal) ; aucun n'a été déduit du contenu. Les deux schémas ont la même structure —
`/dev/sda` et `/dev/sdb`, démarrage BIOS (partition `legacy`), RAID 1 `md0` pour
`/boot` et `md1` pour `/` — et ne diffèrent que par la clé `zfs`.

## Les utiliser

```bash
python3 scripts/preparer-forge.py partitionnement --defaut deploy/cloud-init/offres/EM-B311X-SATA.json
python3 scripts/preparer-forge.py cloud-init      --defaut deploy/cloud-init/offres/EM-B311X-SATA.json --arc-gib <N>
```

## Ce qu'ils ne disent pas

**La capacité des disques.** Le schéma ne la contient pas, et elle ne se déduit pas du
nom de l'offre : la console de l'hébergeur la contrôle à la commande. Ne la notez pas
ici sans l'avoir relevée sur la console, avec la date.

## Ajouter une offre

1. Console de l'hébergeur, à la commande : *Configure disk partitions*, *Custom
   configuration*, *Reset to default*.
2. Copier le JSON affiché **tel quel** dans `<offre>.json`, nommé comme l'offre. Un
   fichier de données ne se reformate pas à la main.
3. Ajouter une ligne au tableau ci-dessus : le nom, la date du relevé, ce qui le
   distingue des autres.
4. Lancer les preuves : `make sparkd-test`. L'une d'elles dérive **chaque** fichier de
   ce dossier ; un défaut qui sort de la règle (pas deux disques, partition `root`
   absente…) est refusé avec ses mots avant qu'on commande la machine.

Un fichier JSON ne porte pas de commentaire : la provenance et la date vivent dans ce
tableau, pas dans le fichier.
