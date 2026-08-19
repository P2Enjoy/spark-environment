# @spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §10 (Decoupage du monorepo)
# Commandes de haut niveau du monorepo. Les cibles Python et TypeScript sont
# volontairement separees : deux livrables, deux chaines d'outillage.

SPARKD := services/sparkd
VENV   := $(SPARKD)/.venv
PY     := $(VENV)/bin/python

.PHONY: help bootstrap sparkd-install sparkd-test sparkd-run webui-install \
        contract contract-check test build clean

help:
	@echo "bootstrap       installe les dependances des deux livrables"
	@echo "sparkd-install  cree le venv et installe le runtime serveur"
	@echo "sparkd-test     tests unitaires du runtime serveur"
	@echo "sparkd-run      lance sparkd en local sur 127.0.0.1:9876"
	@echo "webui-install   installe les dependances de la console"
	@echo "contract        regenere le contrat d'API et ses types"
	@echo "contract-check  echoue si le contrat committe a derive du code"
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

test: sparkd-test contract-check
	pnpm -r test

build:
	pnpm -r build

clean:
	rm -rf $(VENV) node_modules apps/*/node_modules packages/*/node_modules
