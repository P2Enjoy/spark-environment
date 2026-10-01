# Rapport d'incohérences

Ce fichier n'existe que tant qu'une incohérence relevée n'est pas résolue ; il
est supprimé du dépôt quand il devient vide (CLAUDE.md §5).

## 2026-09-30 · « Les trois degrés s'atteignent au clavier » rouge une fois sur deux campagnes

**Constaté** en rejouant la campagne E2E pendant SPK-132 : rouge à la première
passe (148/149, en 261 ms), vert seul, puis vert à la seconde passe complète
(149/149). La capture d'échec montre `#/forge` dans l'état d'un serveur « qui
peut accepter SSH sans encore porter `sparkd` », comme si la console visait un
autre serveur de l'inventaire que la pile d'épreuve — un état qu'un parcours
antérieur aurait laissé. Le parcours s'exécute AVANT ceux de SPK-132, dont le
code ne touche ni la Forge ni la navigation.

**Arbitré le 2026-10-01** : pas de correction à part — le parcours tourne sur la
pile factice, qui ne valide plus rien (DAT §28.7). Il est absorbé par SPK-138 et
rejoué contre la VM ; l'entrée sort du rapport à ce moment.

## 2026-10-01 · L'aide du gabarit d'alerte nomme huit champs, la Forge en accepte dix

**Constaté** en observant la capture `spk140-vm-refus-garde-la-saisie`, prise
dans la console branchée sur la VM du banc : le refus de la `sparkd` dit
« Champs disponibles : version, ts, forge, action, actor, actor_class,
target_type, target_id, result, message », quand l'aide du champ, sous le
gabarit, n'en nomme que huit — `version` et `actor_class` y manquent
(`apps/webui/src/components/forge-alertes.js`). Le manuel M11 en nomme huit lui
aussi.

**Non résolu ici** : hors du périmètre de SPK-140. À arbitrer par le
responsable : l'aide et le manuel nomment les dix champs, ou la Forge n'en
offre que huit.

## 2026-10-01 · Le panneau « Installer cette Forge » montre des accents graves bruts, sur une Forge installée

**Constaté** sur la capture `spk135-vm-forge-virtio` : en bas de l'onglet
Forge d'une Forge **installée** — tunnel ouvert, code à jour —, le panneau
« Installer cette Forge » dit « Cette destination peut accepter SSH sans encore
porter `sparkd` », et les accents graves s'affichent tels quels
(`apps/webui/src/components/forge-installer.js`). C'est aussi la phrase de la
capture d'échec du parcours clavier instable (entrée ci-dessus).

**Non résolu ici** : hors du périmètre de SPK-135 et de SPK-137. À arbitrer par
le responsable : le panneau n'apparaît que sur une destination qui ne porte pas
`sparkd`, ou sa phrase dit ce qu'elle a relevé ; et le nom s'écrit en `<code>`.

## 2026-10-01 · La modale « Ressources » arrondit la mémoire au gibioctet, et renvoie la valeur arrondie

**Constaté** sur la capture `spk142-vm-reservation-et-plafond`, prise dans la
console branchée sur la VM du banc : un Spark créé avec **512 Mio**, dont on n'a
changé que le réseau, a **1 Gio** de mémoire après « Appliquer les quotas ». La
modale pré-remplit la mémoire par `Math.round(octets / 1 Gio)`
(`apps/webui/src/app.js`) — 0,5 devient 1 —, puis envoie la valeur affichée.
Changer un seul réglage en modifie donc un autre, en silence ; un Spark à
1,25 Gio redescendrait à 1 Gio, ou serait refusé pour rétrécissement.
`DESIGN_SYSTEM.md` §6.9 bis : la valeur affichée est EXACTE sur la grille du
curseur, dont le pas mémoire est 256 Mio.

**Non résolu ici** : hors du périmètre arbitré de SPK-142. À arbitrer par le
responsable : pré-remplir la valeur exacte, et n'envoyer que les réglages
changés. D'ici là, sur un Spark dont la mémoire n'est pas un nombre entier de
gibioctets, la modale ne doit pas être employée.
