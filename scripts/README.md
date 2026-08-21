# scripts — bootstrap, seed, preuves

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §12 · CLAUDE.md §14

Les commandes reproductibles du depot. Le `Makefile` de la racine est leur point
d'entree : une procedure importante ne doit jamais rester dans le seul
historique d'un terminal.


## Les scripts, et ce qu'ils font

| Script | Rôle |
|---|---|
| `dev.sh` | pile de développement : `up`, `seed` |
| `contract.py` | contrat d'API : génération et contrôle |
| `creer-pool.sh` | création du pool de stockage de la Forge (SPK-28) |
| `install-serveur.sh` | installation de la Forge |
| `cle-restreinte.sh` | **produit** la ligne `authorized_keys` de la clé du responsable (SPK-61, `docs/DAT.md` §46) — n'écrit nulle part |
| `garde-ssh.sh` | la garde posée en `command=` sur cette clé. Elle tourne **sur la Forge**, pas ici, et n'accepte que le dépannage du §37.3 |

`garde-ssh.sh` et `cle-restreinte.sh` vont ensemble, et avec un réglage serveur —
`AllowTcpForwarding local` — sans lequel la console tombe en panne au lieu d'être
protégée. La marche à suivre est dans `docs/PROD_MIGRATIONS.md`, OP-10.
