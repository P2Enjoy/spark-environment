"""@verifies docs/BACKLOG.md#SPK-01 · docs/DAT.md §5 (surface reseau), §11 (Securite) ·
             docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.8 (adresse publique du briefing)

Ces tests eprouvent la garde d'adresse d'ecoute, qui porte une invariante de
securite du produit : sparkd ne doit jamais etre joignable depuis le reseau.
Un test qui se contenterait de verifier la valeur par defaut ne prouverait rien ;
ceux-ci verifient surtout les REFUS.
"""

from __future__ import annotations

import pytest

from sparkd.config import ConfigError, load


def test_valeurs_par_defaut_sur_la_boucle_locale():
    config = load({})
    assert config.host == "127.0.0.1"
    assert config.port == 9876
    assert config.bind == "127.0.0.1:9876"
    assert config.driver == "incus"
    assert config.forge_public_address == ""


def test_adresse_publique_de_forge_est_un_fait_configure_et_non_devine():
    assert load({"SPARKD_FORGE_PUBLIC_ADDRESS": "forge.exemple.test"}).forge_public_address == (
        "forge.exemple.test")


@pytest.mark.parametrize(
    "bind",
    ["127.0.0.1:9876", "127.0.0.5:1", "localhost:8080", "[::1]:9876"],
)
def test_boucle_locale_acceptee(bind):
    assert load({"SPARKD_BIND": bind}).port > 0


@pytest.mark.parametrize(
    "bind",
    [
        "0.0.0.0:9876",       # toutes interfaces : le cas le plus dangereux
        "51.158.54.202:9876", # adresse publique de l'hote cible
        "10.77.0.1:9876",     # bridge prive : prive, mais routable
        "example.com:9876",   # un nom peut resoudre ailleurs demain
    ],
)
def test_adresse_routable_refusee(bind):
    with pytest.raises(ConfigError) as refus:
        load({"SPARKD_BIND": bind})
    assert "reseau" in str(refus.value)


@pytest.mark.parametrize("bind", ["9876", "127.0.0.1:port", "127.0.0.1:70000", ":9876"])
def test_bind_malforme_refuse(bind):
    with pytest.raises(ConfigError):
        load({"SPARKD_BIND": bind})


def test_pilote_inconnu_refuse():
    with pytest.raises(ConfigError) as refus:
        load({"SPARKD_DRIVER": "kubernetes"})
    assert "SPARKD_DRIVER" in str(refus.value)


def test_pilote_factice_accepte():
    assert load({"SPARKD_DRIVER": "fake"}).driver == "fake"


def test_niveau_de_log_inconnu_refuse():
    with pytest.raises(ConfigError):
        load({"SPARKD_LOG_LEVEL": "verbeux"})
