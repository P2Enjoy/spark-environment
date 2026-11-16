# deploy — piles par environnement

@spec docs/BACKLOG.md#SPK-01, docs/BACKLOG.md#SPK-23 · docs/DAT.md §12 (Developpement local)

- `dev/` — pile de developpement autonome. Elle doit tourner sans service
  payant et sans acces au serveur cible : `sparkd` y fonctionne avec le pilote
  factice (`SPARKD_DRIVER=fake`), et les preuves reelles d'isolation passent par
  une VM Incus jetable. Unite **SPK-23**.
- `staging/`, `prod/` — variables dediees, documentees dans le `README.md` et
  dans `docs/PROD_MIGRATIONS.md`.
- `cloud-init/` — l'amorce d'une Forge neuve : le script joue par `runcmd` au
  premier demarrage. Le `user-data` complet ne s'ecrit pas a la main : il est
  PRODUIT par `scripts/preparer-forge.py cloud-init` (il n'y a plus de gabarit).
  Unites **SPK-73**, **SPK-158**, **SPK-159**.
- `cloud-init/offres/` — les schemas de partitionnement PAR DEFAUT des offres de
  l'hebergeur relevees (`EM-L101X-SATA`, `EM-B311X-SATA`), un fichier par offre,
  tels qu'affiches par sa console : l'entree de `preparer-forge.py` (`--defaut`).
  `cloud-init/offres/forge/` — pour chacune, le JSON de partition pret a coller (pool
  ZFS declare), PRODUIT par `preparer-forge.py offres` et tenu a jour par une preuve.
  Le cloud-init, lui, n'est PAS versionne : il depend de l'amorce, qui evolue (LEGER par defaut : il telecharge les scripts au commit epingle, sha256 verifie) ; il se
  produit a la demande (`preparer-forge.py cloud-init --offre <NOM>`). Provenance dans
  le README du dossier. Unite **SPK-158**, DAT §66.7 et §66.8.

**Les unites systemd ne vivent PAS ici.** Elles sont emballees avec le paquet,
dans `services/sparkd/src/sparkd/systemd/`, et posees par `python -m
sparkd.install` (`docs/DAT.md` §40.4). `deploy/spark.slice` et
`deploy/sparkd.service` en etaient des copies, retirees le 2026-09-01 : elles
avaient derive — la copie du service avait perdu `SPARKD_NETWORK_BRIDGE` et
figeait le chemin du Python — et aucune des deux ne connaissait
`spark-delegation.service`, l'unite de SPK-71 qui fait tenir la delegation des
controleurs. Deux sources pour une meme unite, c'est une source fausse sur deux.

Un pilote factice sert a eprouver la traduction et l'admission control. Il ne
prouve jamais qu'un quota est applique : cette preuve exige un hote Incus reel
(docs/DAT.md §12).
