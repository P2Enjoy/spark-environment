# deploy — piles par environnement

@spec docs/BACKLOG.md#SPK-01, docs/BACKLOG.md#SPK-23 · docs/DAT.md §12 (Developpement local)

- `dev/` — pile de developpement autonome. Elle doit tourner sans service
  payant et sans acces au serveur cible : `sparkd` y fonctionne avec le pilote
  factice (`SPARKD_DRIVER=fake`), et les preuves reelles d'isolation passent par
  une VM Incus jetable. Unite **SPK-23**.
- `staging/`, `prod/` — variables dediees, documentees dans le `README.md` et
  dans `docs/PROD_MIGRATIONS.md`.
- `cloud-init/` — l'amorce d'une Forge neuve : le script joue par `runcmd` au
  premier demarrage, et son gabarit `user-data`. Unite **SPK-73**.

**Les unites systemd ne vivent PAS ici.** Elles sont emballees avec le paquet,
dans `services/sparkd/src/sparkd/systemd/`, et posees par `python -m
sparkd.install` (`docs/DAT.md` §40.4). `deploy/spark.slice` et
`deploy/sparkd.service` en etaient des copies, retirees le 2026-09-01 : elles
avaient derive — la copie du service avait perdu `SPARKD_NETWORK_BRIDGE` et
figeait le chemin du Python — et celle de la tranche ne portait pas le
`Delegate=` de SPK-71. Deux sources pour une meme unite, c'est une source fausse
sur deux.

Un pilote factice sert a eprouver la traduction et l'admission control. Il ne
prouve jamais qu'un quota est applique : cette preuve exige un hote Incus reel
(docs/DAT.md §12).
