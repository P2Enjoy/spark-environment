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
| `mesures-spk128.sh` | banc de l'ingress (SPK-128) : pose la configuration **produite par `build_config`** sur Caddy 2.6.2 en conteneurs jetables, et vérifie qu'elle ne sert ni n'annonce HTTP/3 et pose `Alt-Svc: clear` — y compris à chaud depuis la forme d'avant —, et qu'un WebSocket la traverse. `--help` ; aucun argument |

`garde-ssh.sh` et `cle-restreinte.sh` vont ensemble, et avec un réglage serveur —
`AllowTcpForwarding local` — sans lequel la console tombe en panne au lieu d'être
protégée. La marche à suivre est dans `docs/PROD_MIGRATIONS.md`, OP-10.

**Le réglage serveur en compte deux depuis le 2026-09-26** :
`AllowStreamLocalForwarding no` s'ajoute à `AllowTcpForwarding local`. MESURÉ
(`docs/DAT.md` §46.7) : ce qui refuse une redirection vers la socket d'Incus est
le `permitopen` de la ligne, et rien d'autre — une ligne qui le perdrait ouvrirait
Incus en `root`. Le réglage serveur ferme le même canal sans dépendre d'aucune
virgule.
