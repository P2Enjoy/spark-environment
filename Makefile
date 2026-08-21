# @spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §10 (Decoupage du monorepo)
# Commandes de haut niveau du monorepo. Les cibles Python et TypeScript sont
# volontairement separees : deux livrables, deux chaines d'outillage.

SPARKD := services/sparkd
VENV   := $(SPARKD)/.venv
PY     := $(VENV)/bin/python

.PHONY: help bootstrap sparkd-install sparkd-test sparkd-run webui-install \
        contract contract-check test gestes e2e captures manuel runDev runProd seed build clean

help:
	@echo "bootstrap       installe les dependances des deux livrables"
	@echo "sparkd-install  cree le venv et installe le runtime serveur"
	@echo "sparkd-test     tests unitaires du runtime serveur"
	@echo "sparkd-run      lance sparkd en local sur 127.0.0.1:9876"
	@echo "webui-install   installe les dependances de la console"
	@echo "contract        regenere le contrat d'API et ses types"
	@echo "contract-check  echoue si le contrat committe a derive du code"
	@echo "runDev          pile de developpement : sparkd factice + console"
	@echo "runProd         console d exploitation seule : inventaire du poste, tunnels SSH"
	@echo "seed            recree le registre de developpement et le peuple"
	@echo "gestes          parcours navigateur des gestes d'administration"
	@echo "e2e             parcours complets contre la pile reelle"
	@echo "manuel          reproduit les illustrations du manuel utilisateur"
	@echo "captures        captures d'interface, a OBSERVER (CLAUDE.md §16)"
	@echo "test            toutes les suites de tests"
	@echo "build           build de tous les paquets"

bootstrap: sparkd-install webui-install

sparkd-install:
	python3 -m venv $(VENV)
	$(PY) -m pip install --quiet --upgrade pip
	$(PY) -m pip install --quiet -e "$(SPARKD)[dev]"

sparkd-test:
	$(PY) -m pytest $(SPARKD)/tests -q

sparkd-run:
	$(PY) -m sparkd

webui-install:
	pnpm install

contract:
	$(PY) scripts/contract.py
	pnpm --filter @spark/contract generate

contract-check:
	$(PY) scripts/contract.py check

# Pile de developpement (docs/DAT.md §28). Deux processus, aucun service a
# orchestrer : aucun demon Docker n'est requis.
runDev:
	./scripts/dev.sh up

seed:
	./scripts/dev.sh seed

# Console d'EXPLOITATION (CLAUDE.md §3). Elle n'est pas la pile de developpement
# sans le mot « dev » : c'est un processus, pas deux.
#
#   runDev  : sparkd FACTICE local + console, inventaire jetable dans .dev/
#   runProd : la console SEULE, inventaire du poste, tunnels vers de vraies Forges
#
# Aucun sparkd ne tourne ici : la console en atteint un par tunnel SSH, sur la
# machine qui le porte. Lancer un sparkd local en croyant faire de la production
# donnerait une console qui administre un registre vide.
#
# Le PORT differe de celui de runDev, et ce n'est pas un detail : les deux
# cibles servent deux consoles differentes — l'une sur un sparkd factice,
# l'autre sur de vraies Forges — et l'on veut pouvoir comparer les deux a
# l'ecran. Un port partage obligeait a en arreter une pour voir l'autre.
runProd: SPARK_CONSOLE_PORT ?= 5175
runProd:
	@echo "Console d'exploitation — http://127.0.0.1:$(SPARK_CONSOLE_PORT)"
	@echo "Inventaire : $${SPARK_CONSOLE_STATE:-$$HOME/.config/spark/servers.json}"
	@echo "Aucun sparkd local : les Forges sont atteintes par tunnel SSH."
	cd apps/webui && SPARK_CONSOLE_PORT=$(SPARK_CONSOLE_PORT) node host/main.js

# Les parcours navigateur font partie de la campagne : un test hors campagne
# cesse d'etre execute, puis cesse d'etre vrai.
gestes:
	node --test e2e/gestes.test.mjs

# Parcours E2E : le harnais monte SA pile (docs/DAT.md §29.2). Sequentiel, car
# les parcours partagent un navigateur et une pile.
e2e:
	node --test --test-concurrency=1 e2e/parcours.test.mjs

captures:
	node e2e/captures.mjs

# Les illustrations du manuel sont PRODUITES depuis l'application (DAT §30.1),
# jamais collectees a la main.
manuel:
	node e2e/manuel.mjs

test: sparkd-test contract-check
	pnpm -r test
	$(MAKE) gestes
	$(MAKE) e2e
	node --test e2e/manuel.test.mjs

build:
	pnpm -r build

clean:
	rm -rf $(VENV) node_modules apps/*/node_modules packages/*/node_modules
