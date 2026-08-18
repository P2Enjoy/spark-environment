# deploy — piles par environnement

@spec docs/BACKLOG.md#SPK-01, docs/BACKLOG.md#SPK-23 · docs/DAT.md §12 (Developpement local)

- `dev/` — pile de developpement autonome. Elle doit tourner sans service
  payant et sans acces au serveur cible : `sparkd` y fonctionne avec le pilote
  factice (`SPARKD_DRIVER=fake`), et les preuves reelles d'isolation passent par
  une VM Incus jetable. Unite **SPK-23**.
- `staging/`, `prod/` — variables dediees, documentees dans le `README.md` et
  dans `docs/PROD_MIGRATIONS.md`.

Un pilote factice sert a eprouver la traduction et l'admission control. Il ne
prouve jamais qu'un quota est applique : cette preuve exige un hote Incus reel
(docs/DAT.md §12).
