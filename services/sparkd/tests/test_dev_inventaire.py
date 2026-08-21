"""@verifies docs/BACKLOG.md#SPK-41 · docs/DAT.md §22.4 (l'inventaire de la
            console), §28.2 (le serveur local de la pile de développement)

Ce que ces preuves gardent : **la pile de développement ne détruit pas ce que le
responsable a saisi.**

Défaut constaté le 2026-08-21, rapporté par le responsable : « pourquoi la console
web perd les serveurs que je dois rajouter à chaque fois ? » `scripts/dev.sh`
réécrivait l'inventaire **en entier** à chaque démarrage. Les deux serveurs de la
pile revenaient, et tout ce qui avait été ajouté depuis la console disparaissait.

Le VRAI script est exécuté, jamais une reformulation de sa logique : on l'appelle
avec un argument inconnu, ce qui le fait sortir sur son message d'usage **après**
avoir écrit l'inventaire. Le mécanisme éprouvé est donc bien celui qui tourne.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

RACINE = Path(__file__).resolve().parents[3]
SCRIPT = RACINE / "scripts" / "dev.sh"


def _lancer(inventaire: Path, etat: Path, bind: str = "127.0.0.1:9876") -> dict:
    """Exécute le script jusqu'à l'écriture de l'inventaire, et rend ce qu'il a écrit."""
    subprocess.run(
        ["bash", str(SCRIPT), "argument-inconnu"],
        cwd=RACINE, check=False, capture_output=True,
        env={"PATH": "/usr/bin:/bin", "HOME": str(etat),
             "SPARK_DEV_STATE": str(etat), "SPARK_CONSOLE_STATE": str(inventaire),
             "SPARKD_BIND": bind},
    )
    return json.loads(inventaire.read_text(encoding="utf-8"))


def test_un_serveur_ajoute_survit_au_redemarrage(tmp_path: Path):
    """Le défaut rapporté : ressaisir ses serveurs à chaque démarrage."""
    inventaire = tmp_path / "servers.json"
    inventaire.write_text(json.dumps({
        "version": 1, "current": "forge1",
        "servers": [
            {"name": "local", "kind": "local", "host": "127.0.0.1", "port": 1111},
            {"name": "forge1", "kind": "ssh", "host": "203.0.113.7",
             "user": "ubuntu", "remotePort": 9876},
        ],
        "anchors": {"forge1": {"head": "abc"}},
    }), encoding="utf-8")

    etat = _lancer(inventaire, tmp_path / "dev")
    noms = [s["name"] for s in etat["servers"]]

    assert "forge1" in noms, "le serveur saisi par le responsable a été effacé"
    assert etat["current"] == "forge1", "le serveur courant a été perdu"
    assert etat["anchors"] == {"forge1": {"head": "abc"}}, (
        "les ancres du journal ont été perdues — la console croirait voir une "
        "première comparaison sur une histoire qu'elle connaissait")


def test_les_deux_serveurs_de_la_pile_sont_garantis(tmp_path: Path):
    """Sans eux, la pile ne montre ni le sélecteur ni un tunnel fermé (§28.2)."""
    inventaire = tmp_path / "servers.json"
    inventaire.write_text(json.dumps({
        "version": 1, "current": "forge1",
        "servers": [{"name": "forge1", "kind": "ssh", "host": "203.0.113.7",
                     "user": "ubuntu", "remotePort": 9876}],
    }), encoding="utf-8")

    etat = _lancer(inventaire, tmp_path / "dev")
    noms = [s["name"] for s in etat["servers"]]

    assert noms[:2] == ["local", "recette"], (
        "les deux serveurs de la pile doivent être présents et en tête")


def test_le_port_du_serveur_local_suit_SPARKD_BIND(tmp_path: Path):
    """Il change avec la pile : le conserver ferait pointer la console à côté."""
    inventaire = tmp_path / "servers.json"
    inventaire.write_text(json.dumps({
        "version": 1, "current": "local",
        "servers": [{"name": "local", "kind": "local", "host": "127.0.0.1",
                     "port": 1111}],
    }), encoding="utf-8")

    etat = _lancer(inventaire, tmp_path / "dev", bind="127.0.0.1:9976")
    local = next(s for s in etat["servers"] if s["name"] == "local")

    assert local["port"] == 9976


def test_un_inventaire_absent_ou_illisible_ne_fait_pas_echouer_la_pile(tmp_path: Path):
    """Un fichier de développement se recrée ; il ne bloque pas un démarrage."""
    absent = tmp_path / "jamais-ecrit.json"
    etat = _lancer(absent, tmp_path / "dev")
    assert [s["name"] for s in etat["servers"]] == ["local", "recette"]

    casse = tmp_path / "casse.json"
    casse.write_text("{ceci n'est pas du JSON", encoding="utf-8")
    etat = _lancer(casse, tmp_path / "dev2")
    assert [s["name"] for s in etat["servers"]] == ["local", "recette"]


def test_un_serveur_courant_devenu_absent_retombe_sur_local(tmp_path: Path):
    """§14.5 : un pointeur qui ne désigne plus rien vaut null, pas une panne."""
    inventaire = tmp_path / "servers.json"
    inventaire.write_text(json.dumps({
        "version": 1, "current": "disparu", "servers": [],
    }), encoding="utf-8")

    etat = _lancer(inventaire, tmp_path / "dev")
    assert etat["current"] == "local"
