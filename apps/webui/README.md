# @spark/webui — console d'administration locale

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §6 (Plan d'administration), §10 (Decoupage du monorepo)

Ce paquet portera les deux moities de la console, qui s'executent **sur le poste
du responsable** et jamais sur le serveur :

- `host/` — le processus local Node. Il detient l'inventaire des serveurs, ouvre
  et surveille les tunnels SSH, et relaie `/api/*` vers `127.0.0.1:<port local>`.
  C'est lui qui sait faire du SSH, parce qu'un navigateur ne le peut pas et ne
  doit pas le faire (docs/DAT.md §6). Unite **SPK-16**.
- `src/` — la SPA React/Vite. Unites **SPK-18** a **SPK-22**.

## Pourquoi ce paquet est vide

Le squelette du monorepo (SPK-01) declare ce livrable et le cable dans l'espace
de travail, mais n'ecrit pas sa source.

`CLAUDE.md` §4 impose de lire **integralement** `docs/DESIGN_SYSTEM.md` avant
toute ecriture touchant l'interface. Cette lecture appartient a l'unite qui
construit reellement l'interface, pas au squelette. Poser ici quelques
composants d'attente reviendrait a produire de l'UI sans avoir satisfait cette
condition, et a livrer un ecran que personne n'a specifie.

La chaine d'outillage TypeScript (Vite, React, Vitest, Playwright) est installee
avec la premiere unite qui en a besoin, pour ne pas figer des versions avant de
savoir ce qu'elles doivent porter.
