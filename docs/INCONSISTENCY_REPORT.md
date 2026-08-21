# Registre des incohérences

Défauts constatés en travaillant, **étrangers à l'unité en cours**. Le
comportement est laissé inchangé (`CLAUDE.md` §5, CloudWorker §3.1) : ils sont
consignés avec leur mesure, pas corrigés au passage.

Une entrée résolue est **retirée** de ce fichier. Lorsqu'il devient vide, le
fichier est supprimé du dépôt.

> Ce fichier a été supprimé le 2026-08-20 quand sa dernière entrée a été traitée,
> puis recréé le même jour au premier écart suivant. C'est le cycle voulu.

## Ouverts

### INC-05 · `e2e/reel.mjs` attend un écran que la navigation ne montre plus

**Constaté le** 2026-08-20, en refaisant les captures pour la DoD de SPK-42.

**Mesure.** Le script s'arrête à sa quatrième étape :

```
page.waitForSelector: Timeout 10000ms exceeded.
  - waiting for locator('#titre-routes') to be visible
    at e2e/reel.mjs:63
```

Il ouvre un Spark puis attend immédiatement `#titre-routes`. Depuis **SPK-33**,
la fenêtre d'un Spark s'ouvre sur la facette *Infos* et les routes publiques
vivent derrière un onglet (`docs/DAT.md` §34.2). Le titre n'existe donc pas à ce
moment-là, et n'existera jamais sans un clic sur l'onglet.

**Ligne de base établie** (§2.4) : le script échoue **à l'identique** avant et
après le changement de la session — `git stash -u`, exécution, `git stash pop`.
Ce n'est pas une régression du renommage.

**Pourquoi il est passé inaperçu.** `reel.mjs` n'est appelé par **aucune cible du
Makefile** : `make captures` exécute `e2e/captures.mjs`, `make manuel` exécute
`e2e/manuel.mjs`. Ce script n'appartient à aucune campagne, il n'a donc jamais
rougi devant personne depuis SPK-33.

**Impact.** Les captures `40-reel-*` à `45-reel-*` — celles qui montrent la
console contre un runtime RÉEL, par opposition au faux `sparkd` de
`captures.mjs` — ne sont plus régénérables. Elles restent dans le dépôt, figées à
leur dernière production réussie, et **rien ne signale qu'elles vieillissent**.

**Comportement laissé inchangé.** Le script n'est pas corrigé ici : ce serait
corriger un défaut étranger à l'unité en cours (CloudWorker §3.1).

**Ce que sa correction demanderait**, pour la session qui s'en chargera : ajouter
le clic sur l'onglet *Routes* comme le fait déjà `ouvrir()` dans
`e2e/parcours.test.mjs`, **et** rattacher `reel.mjs` à une cible du `Makefile` —
sans quoi il rougira de nouveau sans témoin à la prochaine refonte de navigation.

### INC-06 · Quatre classes employées par la console n'existent pas dans le CSS

**Constaté le** 2026-08-20, en introduisant le contrôle que le §12.3 du design
system exige — lui-même motivé par un défaut de la tranche 4 de SPK-43, où
`bouton--danger` avait été écrit à la place de `bouton--destructif`.

**Mesure.** Balayage des attributs `class="…"` littéraux de
`apps/webui/src/components/*.js` et de `apps/webui/src/app.js`, confrontés aux
sélecteurs de `apps/webui/src/styles/app.css` et `tokens.css` :

```
controle--compact  → app.js
epreuve--absent    → servers-view.js
epreuve--ok        → servers-view.js
recette-lignes     → spark-admin.js
```

**Ce que cela produit.** Ces classes ne peignent rien. L'écran se rend, sans le
style attendu, et aucune preuve ne le dit : une assertion qui cherche la classe
dans la chaîne rendue reste verte — elle prouve qu'on l'a écrite, pas qu'elle
existe. C'est exactement ce que le §12.3 décrit.

**Ce qui n'est pas mesuré.** L'écart visuel réel de chacune : il faudrait
regarder les trois écrans concernés, ce qui appartient à leurs unités et non à
celle en cours. `epreuve--ok` et `epreuve--absent` portent vraisemblablement une
couleur de verdict (SPK-41), `controle--compact` une densité de champ,
`recette-lignes` la mise en page du compte rendu d'une recette (SPK-50).

**Comportement laissé inchangé** (CloudWorker §3.1). Les quatre sont nommées
dans `CONNUES`, au sein de `apps/webui/src/styles/classes.test.js`. Cette liste
ne peut que décroître : une classe neuve absente du CSS fait échouer le
contrôle, et un second test refuse qu'une classe soldée y reste.

**Pour clore.** Décider, pour chacune, si la classe doit être ajoutée au CSS ou
retirée du composant, en regardant l'écran concerné ; puis la retirer de
`CONNUES` et cette entrée du registre.

### INC-07 · Les onglets de la fenêtre d'un Spark débordent la page sous 390 px

**Constaté le** 2026-08-20, en vérifiant au format étroit la bannière du chemin
de dépannage (SPK-43, tranche 4).

**Mesure.** Fenêtre 390 × 844, écran d'un Spark, onglet *Terminal* :

```
liste     scrollWidth 390 / vue 390   → conforme, le tableau défile dans SON conteneur
terminal  scrollWidth 552 / vue 390   → la PAGE déborde
coupables : a.onglet → 464 · a.onglet → 552
```

**Ligne de base établie** (CloudWorker §2.4) : `git stash -u` sur
`apps/webui/src` et `apps/webui/host`, mesure rejouée, **chiffres identiques**.

**Reconstaté le** 2026-08-20 sur un autre écran, celui d'un conteneur ouvert
(SPK-44, deuxième tranche). Mêmes coupables, mêmes onglets :

```
conteneur ouvert  scrollWidth 637 / vue 390   → la PAGE déborde de 247 px
coupables : a.onglet (65 px) · a.onglet.onglet--courant (159 px) · a.onglet (247 px)
```

Ce que cette deuxième mesure ajoute : le défaut ne tient à aucun contenu
particulier. Il ne vient ni du terminal ni du journal, qui défilent l'un et
l'autre dans leur propre bloc — la preuve
`sur 390 px, les journaux défilent dans LEUR bloc` le mesure séparément et passe.
Il vient de la barre d'onglets seule, sur **tout** écran de Spark.
Le défaut est donc préexistant et n'appartient pas à la tranche 4 de SPK-43.

**Ce que cela viole.** `docs/DESIGN_SYSTEM.md` §8.1 : « La page ne défile jamais
horizontalement. » La rangée d'onglets de la fenêtre d'un Spark — *Infos*,
*Routes*, *Clés*, *Instantanés*, *Terminal*, *Journal*, et *Docker* quand
SPK-44 l'ajoutera — dépasse 390 px et pousse le document entier. Le §8.2 exige en
outre qu'un débordement soit **signalé** : ici il ne l'est pas, et les deux
derniers onglets sont simplement hors champ.

**À distinguer du cas conforme.** Sur la liste des Sparks, le tableau large
défile bien dans son propre conteneur : `scrollWidth` reste égal à la vue. C'est
la forme attendue, et elle montre que le défaut est propre à la rangée d'onglets.

**Comportement laissé inchangé** (CloudWorker §3.1). La rangée d'onglets
appartient à SPK-33 (les trois degrés de navigation), et la corriger demanderait
de trancher entre défilement local signalé, repli, ou tiroir — un arbitrage de
navigation qui déborde de l'unité en cours.

**Pour clore.** Décider de la forme au format étroit, l'appliquer à
`.onglet`, et vérifier par une mesure que `scrollWidth` retombe à la largeur de
la vue sur les sept facettes.

### INC-08 · L'erreur d'un champ survit à sa correction, jusqu'à la soumission suivante

**Constaté le** 2026-08-20, en observant les captures de SPK-59.

**Mesure.** Sur `e2e/captures/17-creation-avertissement.png` et
`16-creation-forme-invalide.png` : le champ *Nom* porte « gros-spark », une valeur
parfaitement bien formée, et l'écran affiche toujours dessous, en rouge,
« Requis pour créer un Spark. » L'erreur date de la soumission vide précédente.

**Cause.** `etat.creation.errors` n'est recalculé que dans `creer()`, à la
soumission. L'écouteur `input` du formulaire écrit la valeur dans l'état mais ne
rejoue pas `validateShape`, et rien ne repeint le champ. L'erreur reste donc
affichée jusqu'à la soumission suivante.

**Ligne de base établie** : le défaut est visible sur la capture 17 telle qu'elle
existait AVANT SPK-59 — le champ portait déjà « gros-spark » et déjà le message
rouge. Il est antérieur aux curseurs et ne leur appartient pas.

**Ce que cela viole.** `docs/DESIGN_SYSTEM.md` §6.12 : « Un champ manquant et un
champ incorrect ne constituent pas le même état. » Un message d'erreur qui ne
décrit plus le champ qu'il désigne est un indicateur qui ment, et le §5.1 du même
document dit qu'un indicateur qui ment est pire qu'un indicateur absent.

**Comportement laissé inchangé** (CloudWorker §3.1). La correction demande de
trancher QUAND une erreur de forme se réévalue — à chaque frappe, à la perte du
focus, ou seulement après une première soumission —, et cet arbitrage appartient
à l'écran de création dans son ensemble, pas à l'unité qui a changé la forme de
ses contrôles de quota.


### INC-09 · `POST /v1/audit` promet une entrée qu'il ne rend jamais

**Constaté le** 2026-08-20, en étendant la porte du §37.4.6 aux gestes de
conteneur (SPK-45).

**Mesure.** Sur une pile jetable, une déclaration valide :

```
POST /v1/audit {"action":"spark.container_stop","target_id":"crm", …}
=> 201 {"recorded": "spark.container_stop", "entry": null}
```

L'entrée est pourtant bien inscrite : elle se relit aussitôt par
`GET /v1/audit?action=spark.container_stop`.

**Cause.** `services/sparkd/src/sparkd/app.py`, route `declare_audit` : elle
compose sa réponse avec `entree = audit_service.record(...)`, et `record` ne
retourne rien. Le champ `entry` vaut donc `null` à **toute** déclaration, depuis
l'ouverture de cette porte par SPK-43.

**Ligne de base établie** : le champ est `null` sur `origin/main` avant ce
changement — la valeur ne dépend ni de l'action déclarée ni de sa charge. Le
défaut est antérieur à SPK-45 et ne lui appartient pas.

**Ce que cela viole.** `CLAUDE.md` §3, « préférer les contrats explicites entre
les composants » : une réponse qui nomme un champ toujours vide se lit comme une
information manquante, pas comme une information inexistante. Un appelant qui
voudrait confirmer l'inscription lirait `null` et conclurait à un échec, alors
que l'entrée est là.

**Ce que ce n'est pas.** Une fuite ni une perte : rien n'est perdu, l'entrée
rejoint la chaîne d'intégrité comme prévu. C'est un champ mort dans une réponse.

**Comportement laissé inchangé** (CloudWorker §3.1). La correction demande de
trancher ce que la porte doit rendre — l'entrée entière, son seul identifiant, ou
rien du tout —, et cela touche le contrat d'API partagé (SPK-17) autant que cette
route. L'arbitrage dépasse l'unité qui a seulement élargi la liste blanche.

### INC-10 · La bannière du terminal annonce une session « SSH » quand aucune n'est ouverte

**Constaté le** 2026-08-20, en éprouvant le refus d'un conteneur sans shell
(SPK-45, tranche 2).

**Mesure.** `renderTerminal` avec `status: 'ferme'` et `session: null` :

```
bannière présente sans session : true
elle annonce : « SSH » | « Quitter cet onglet termine la session »
```

**Ligne de base établie** (CloudWorker §2.4) : `git stash -u` sur
`apps/webui/src/components/spark-terminal.js` seul, mesure rejouée, **résultat
identique**. Le défaut est antérieur à SPK-45 et ne lui appartient pas.

**Cause.** Le bandeau est rendu inconditionnellement, et le chemin retombe sur
`CHEMINS.ssh` faute de session : `const chemin = CHEMINS[etat.session?.path] ??
CHEMINS.ssh`.

**Ce que cela viole.** `docs/DESIGN_SYSTEM.md` §14.6 — « inconnu » n'est pas une
valeur — et §1.4 : l'écran affiche l'état d'une session qui n'existe pas, et
promet qu'en quittant l'onglet on la terminera. Sur un écran où l'on vient
précisément d'apprendre qu'aucun terminal ne peut s'ouvrir, la ligne se lit comme
une contradiction.

**Ce que ce n'est pas.** Une fuite ni une perte : aucune session n'est réellement
ouverte, et le §37.4 est tenu. C'est un écran qui décrit ce qui n'est pas là.

**Comportement laissé inchangé** (CloudWorker §3.1). La correction demande de
trancher ce que le bandeau doit dire hors session — disparaître, ou annoncer
« aucune session » —, et cela touche l'écran du terminal dans son ensemble, pas
l'unité qui y a ajouté un troisième chemin.


### INC-11 · Un parcours du terminal est vert SEUL et rouge dans la série

**Observé le 2026-08-21**, en livrant SPK-62. Consigné sans être tranché : rien
n'établit qu'il soit imputable à cette unité, et le §2.4 interdit de conclure à
une régression sans ligne de base.

**Ce qui est mesuré, et rien de plus :**

```
node --test --test-name-pattern="entrer dans le terminal" e2e/parcours.test.mjs
  => ok 1, pass 1, fail 0

make e2e (série complète, même dépôt, même minute)
  => ✖ entrer dans le terminal, écrire, voir répondre, quitter, et le distant meurt
     échec en 707 ms ; l'écran capturé montre « Ouvrir un terminal », donc AUCUNE
     session ouverte, là où le parcours en attend une.
```

Les 71 autres parcours sont verts, y compris les trois autres qui ouvrent une
session — « quitter l'ONGLET », « un distant qui MEURT », « confirmer le
dépannage ».

**Ce qui n'est PAS établi** : la cause. Trois pistes, aucune vérifiée —
l'inactivité qui ferme une session (§37.4.3) pendant qu'un parcours antérieur
occupe la pile ; un reste d'état du gestionnaire de sessions entre parcours ; une
course entre l'ouverture du flux et la première assertion.

**Ce qui a été écarté** : le parcours de SPK-62 ne touche ni à
« crm-production », ni au terminal. Il démarre puis arrête « boutique », lève
puis réarme la protection d'« analytics », et rend la pile à l'état du seed —
vérifié par une assertion du parcours lui-même.

**Comportement laissé inchangé.** L'arbitrage appartient au responsable :
diagnostiquer une instabilité de harnais est une unité en soi, et la traiter au
passage aurait mêlé deux sujets.

**NON REPRODUIT le 2026-08-21 à 03h**, et la tentative est écrite pour que la
suivante n'ait pas à la refaire :

```
série complète, seed fraîchement appliqué   =>  73 parcours, 0 échec
série complète REJOUÉE sans reseed          =>  73 parcours, 0 échec
```

La seconde exécution éprouvait l'hypothèse la plus probable — l'échec était
apparu à la DEUXIÈME série d'une même session — et l'**infirme**. Le harnais
monte de toute façon sa propre pile jetable à chaque série (§29.2), donc l'état
du seed ne se transmet pas d'une série à l'autre.

**Rien n'a été corrigé, et c'est délibéré** : le `CLAUDE.md` §18 exige de
reproduire un défaut avant d'en traiter la cause. Corriger ce qu'on n'observe pas
reviendrait à poser une temporisation ou un contournement, que le §3.1 du
`CloudWorker.md` interdit nommément.

**Ce que la prochaine occurrence doit relever** pour trancher : le fichier de
diagnostic `e2e/captures/echecs/terminal.txt`, l'ordre exact des parcours joués
avant lui, et si la machine était chargée — deux séries E2E tournaient en
parallèle dans la session où il est apparu.

---

**DEUXIÈME OCCURRENCE, le 2026-08-21 à 04h30**, et elle apporte l'observation qui
manquait. Le relevé demandé ci-dessus a été fait.

```
série complète         =>  72 parcours verts, 1 échec — le même
le parcours JOUÉ SEUL  =>  ok, dans la minute qui suit
```

**Ce que l'écran montrait au moment de l'échec** — et c'est nouveau :

```
Terminal
SSH
Quitter cet onglet termine la session.
Session fermée.
```

La session **s'est ouverte**, puis **s'est refermée** avant que le parcours
n'achève ses assertions. Le défaut n'est donc PAS « la session ne s'ouvre pas »,
comme la première occurrence le laissait croire — c'est « elle ne dure pas ».

Cela déplace le diagnostic vers trois mécanismes qui ferment une session, tous
trois documentés, et dont aucun n'est encore mis en cause :

- la **fermeture du flux tue la session** (§37.4.2) — un flux d'évènements que le
  navigateur laisse tomber sous charge suffirait ;
- l'**inactivité** ferme après un délai (§37.4.3) ;
- le **distant qui se termine** ferme aussi : le doublon du harnais est `cat`,
  qui rend la main dès que son entrée se ferme.

**Toujours pas corrigé, et toujours délibérément** : trois causes plausibles, une
seule est la bonne, et le §18 exige de reproduire avant de traiter. Le parcours
passe seul, ce qui interdit d'incriminer le produit sans mesure supplémentaire.

**Ce que la prochaine occurrence doit relever**, maintenant que la piste est
resserrée : le journal de l'hôte console pour CE parcours — il dit lequel des
trois motifs de fermeture a été employé (`DISTANT_TERMINE`, inactivité, ou
fermeture du flux). C'est ce motif, et lui seul, qui tranche.

### INC-12 · Les refus chiffrés annoncent des octets bruts sous un écran en Gio

**Constaté le** 2026-08-21, en observant la capture
`e2e/captures/55-quotas-refus-disque.png` produite pour SPK-57.

**Mesure.** La modale des quotas se saisit en **Gio** — trois champs le disent
sous eux, « en Gio ». Le refus qu'elle affiche, lui, est en octets :

```
« crm-production » occupe actuellement 534981632 octets de disque :
descendre sa taille à 0 perdrait des données.
```

Le refus d'admission fait de même, et il est **antérieur** :

```
Capacité insuffisante — memory : 68719476736 octets demandés,
4294967296 disponibles (capacité 81854656512, alloué 77559689216)
— il manque 64424509440 octets
```

L'exploitant doit donc convertir de tête pour comparer le chiffre du refus à
celui qu'il vient de taper. C'est exactement ce que le §1.5 bis du design system
demande d'éviter : « la valeur, son unité », et le §6.9 bis prend soin de montrer
« 16 Gio » là où le contrôle vaut « 16 ».

**Pourquoi ce n'est PAS corrigé ici.** Le défaut porte sur **deux** familles de
refus, et une seule appartient à SPK-57. Ne formater que celle-là ferait dire la
même grandeur de deux façons selon le refus reçu — une divergence pire que le
défaut d'origine. Le geste juste est un formatage unique, partagé par les refus
de l'admission (§7.7) et du rétrécissement (§49.3), et il dépasse l'unité en
cours (CloudWorker §3.1).

**Ce qu'il faudrait.** Une seule fonction de rendu des grandeurs côté runtime,
employée par les deux constructeurs de message, et le choix de l'unité tranché :
la même que celle du champ saisi. Les champs machine (`in_use`, `requested`,
`shortfalls`) restent en octets — ils ne sont pas lus par un humain.

### INC-13 · Le harnais de captures finit sur une console NON VIERGE

**Constaté le** 2026-08-21, en produisant les captures de la facette
*Environnement* (SPK-58).

**Mesure.** `node e2e/captures.mjs` se termine par :

```
  CONSOLE NON VIERGE — 1 message(s) de l’application :
    [error] Failed to load resource: net::ERR_CONNECTION_REFUSED
```

**Ligne de base établie** (§2.4), et c'est le point : le harnais rend le message
**à l'identique** sur `cfe5b87`, avant tout changement de cette session. Ce n'est
donc pas une régression, et la facette neuve n'en est pas la cause.

**Ce que cela coûte.** Le harnais sort en code 0 malgré ce bilan — vérifié —,
donc la campagne reste verte. Mais la règle du CloudWorker demande une console
**vierge de toute erreur**, et un message permanent rend cette garde inopérante :
le jour où un vrai défaut d'application s'y ajoutera, il se lira comme le bruit
habituel.

**Piste, non vérifiée.** Le message ne porte pas d'URL, donc la requête n'est pas
identifiée. Le harnais ferme ses piles successives par `ctx.server.close()`
pendant que la page reste sur l'ancienne adresse ; une requête encore en vol
tomberait alors sur un port fermé. Déplacer un bloc de captures en fin de fichier
n'a **pas** fait disparaître le message — donc ce n'est pas un simple effet
d'ordre, et l'hypothèse reste à éprouver.

**Ce qu'il faudrait.** Faire porter l'URL au message collecté, ce qui suffirait à
nommer la requête fautive. C'est une modification du harnais, étrangère à
l'unité en cours (CloudWorker §3.1).
