"""@verifies docs/BACKLOG.md#SPK-135 · docs/DAT.md §5.3 bis (le débit déclaré du plan)
@verifies docs/BACKLOG.md#SPK-129 · docs/DAT.md §51.5 (Caddy porté par
`caddy-api.service`, `caddy.service` masqué, reprise sur panne ; une seule
fonction pour l'exécuteur et pour `sparkd.install`)

Le défaut prouvé ici a coûté deux heures d'ingress le 2026-09-14 : `caddy.service`
repart du `Caddyfile` à chaque démarrage, et toute Forge montée par le cloud-init
l'activait.
"""

from __future__ import annotations

import subprocess

import pytest
from pathlib import Path

from sparkd import caddy_unite, forge_install


def lecteur(fichier: str, api: str, api_actif: str, lues: list | None = None):
    valeurs = {("caddy.service", "UnitFileState"): fichier,
               ("caddy-api.service", "UnitFileState"): api,
               ("caddy-api.service", "ActiveState"): api_actif}

    def lire(commande: list[str]) -> str:
        if lues is not None:
            lues.append(commande)
        return valeurs.get((commande[-1], commande[3]), "")
    return lire


def test_une_forge_d_avant_passe_a_caddy_api_dans_le_bon_ordre():
    """`caddy.service` s'arrête AVANT que `caddy-api` démarre : les deux
    écoutent `:80` et `:443`. `disable` avant `mask` : un lien d'activation
    laissé derrière une unité masquée fait échouer son démarrage à chaque boot.
    """
    commandes: list[list[str]] = []
    caddy_unite.aligner(commandes.append, lecteur("enabled", "disabled", "inactive"),
                        complement_change=True)
    assert commandes == [
        ["systemctl", "daemon-reload"],
        ["systemctl", "disable", "caddy.service"],
        ["systemctl", "mask", "--now", "caddy.service"],
        ["systemctl", "enable", "--now", "caddy-api.service"],
    ]


def test_une_forge_alignee_ne_recoit_aucune_commande():
    commandes: list[list[str]] = []
    caddy_unite.aligner(commandes.append, lecteur("masked", "enabled", "active"),
                        complement_change=False)
    assert commandes == []


def test_un_complement_change_ne_redemarre_pas_un_caddy_en_service():
    """`Restart=` vaut dès le `daemon-reload` ; redémarrer couperait l'ingress."""
    commandes: list[list[str]] = []
    caddy_unite.aligner(commandes.append, lecteur("masked", "enabled", "active"),
                        complement_change=True)
    assert commandes == [["systemctl", "daemon-reload"]]


def test_un_caddy_service_absent_est_masque_sans_etre_desactive():
    """Rien à désactiver ; masquer quand même, pour qu'un paquet installé plus
    tard ne puisse pas le démarrer."""
    commandes: list[list[str]] = []
    caddy_unite.aligner(commandes.append, lecteur("", "enabled", "failed"),
                        complement_change=False)
    assert commandes == [
        ["systemctl", "mask", "--now", "caddy.service"],
        ["systemctl", "enable", "--now", "caddy-api.service"],
    ]


def test_l_etat_se_lit_par_show_et_jamais_par_is_enabled():
    """`is-enabled` sort en erreur pour une unité masquée : un lecteur qui
    ignore les codes d'erreur la confondrait avec une unité absente."""
    lues: list[list[str]] = []
    caddy_unite.etat(lecteur("masked", "enabled", "active", lues))
    assert all(c[:2] == ["systemctl", "show"] for c in lues)
    assert not any("is-enabled" in c for c in lues)


def test_le_complement_relance_un_caddy_tombe_et_se_pose_une_fois(tmp_path):
    assert caddy_unite.ecrire(racine=tmp_path) is True
    texte = (tmp_path / "etc/systemd/system/caddy-api.service.d/spark.conf").read_text()
    assert "Restart=on-failure" in texte
    assert caddy_unite.ecrire(racine=tmp_path) is False


def test_l_executeur_d_une_forge_neuve_n_active_plus_le_caddyfile(monkeypatch):
    """Le chemin du cloud-init : `phase_foundation` passait
    `systemctl enable --now caddy`. Elle aligne désormais par la MÊME fonction
    que `sparkd.install`."""
    passees: list[list[str]] = []
    etats = {("caddy.service", "UnitFileState"): "enabled",
             ("caddy-api.service", "UnitFileState"): "disabled",
             ("caddy-api.service", "ActiveState"): "inactive"}

    def faux_run(commande, *, timeout=120, input_text=None, check=True):
        passees.append(commande)
        sortie = ""
        if commande[:2] == ["systemctl", "show"]:
            sortie = etats.get((commande[-1], commande[3]), "")
        elif commande[:3] == ["incus", "network", "get"]:
            sortie = {"ipv4.address": "10.77.0.1/24", "ipv4.nat": "true",
                      "ipv4.dhcp.ranges": "10.77.0.240-10.77.0.254",
                      "user.spark.input_policy": "drop"}.get(commande[4], "")
        return subprocess.CompletedProcess(commande, 0, sortie, "")

    monkeypatch.setattr(forge_install, "_run", faux_run)
    monkeypatch.setattr(forge_install, "_network_exists", lambda nom: True)
    monkeypatch.setattr(forge_install, "_ensure_device", lambda *a, **k: False)
    monkeypatch.setattr(forge_install, "_atomic_write_if_changed", lambda *a: False)
    monkeypatch.setattr(forge_install.pare_feu, "poser",
                        lambda *a, **k: {"changed": False, "commandes": []})
    monkeypatch.setattr(forge_install.caddy_unite, "ecrire", lambda **k: False)

    resultat = forge_install.phase_foundation(
        {"config": {"bridgeName": "sparkbr0", "poolName": "spark"}})

    assert ["systemctl", "enable", "--now", "caddy"] not in passees
    assert ["systemctl", "mask", "--now", "caddy.service"] in passees
    assert ["systemctl", "enable", "--now", "caddy-api.service"] in passees
    assert resultat["changed"] is True


# --- SPK-135 · §5.3 bis : le débit déclaré dans le plan de l'exécuteur -------

def _plan(**config):
    base = {"poolName": "spark", "bridgeName": "sparkbr0", "cpuReserve": 0.5,
            "memoryReserveGib": 2.0, "arcMaxGib": 1.0, "reservedPorts": [22, 80, 443]}
    return {"plan": {
        "version": 1, "system": {"os": "ubuntu", "architecture": "x86_64"},
        "storage": {"kind": "reuse", "poolName": "spark", "driver": "zfs",
                    "destructive": False},
        "config": {**base, **config},
        "phases": [{"id": p, "label": p, "status": "pending"} for p in (
            "access", "dependencies", "storage", "foundation", "control", "verification")],
    }, "confirmation": ""}


def test_le_plan_accepte_un_debit_declare_facultatif(monkeypatch):
    """@verifies docs/BACKLOG.md#SPK-135 · docs/DAT.md §5.3 bis

    La console ne l'envoie pas, l'amorce seulement quand `NET_MBIT` est posé :
    les deux plans restent valides."""
    monkeypatch.setattr(forge_install, "_memory_total", lambda: 64 * 1024**3)
    monkeypatch.setattr(forge_install.os, "geteuid", lambda: 0)
    forge_install.validate_envelope(_plan())
    forge_install.validate_envelope(_plan(networkCapacityMbit=1000))


@pytest.mark.parametrize("debit", [0, -1, "1000", 1.5, True])
def test_un_debit_declare_invalide_est_refuse(monkeypatch, debit):
    monkeypatch.setattr(forge_install, "_memory_total", lambda: 64 * 1024**3)
    with pytest.raises(forge_install.ForgeInstallationError, match="débit"):
        forge_install.validate_envelope(_plan(networkCapacityMbit=debit))


def test_une_autre_cle_reste_un_refus(monkeypatch):
    """La liste reste FERMÉE : la clé facultative n'ouvre pas la porte au reste."""
    monkeypatch.setattr(forge_install, "_memory_total", lambda: 64 * 1024**3)
    with pytest.raises(forge_install.ForgeInstallationError, match="contrat"):
        forge_install.validate_envelope(_plan(autreChose=1))


def test_le_debit_declare_n_est_ecrit_que_s_il_est_donne(monkeypatch, tmp_path):
    """Une déclaration posée à la main survit à une réinstallation qui n'en dit
    rien : l'exécuteur ne réécrit que ce qu'on lui passe."""
    ecrits: list[dict] = []
    monkeypatch.setattr(forge_install, "_merge_environment",
                        lambda reglages: ecrits.append(reglages) or False)
    monkeypatch.setattr(forge_install.package_install.Paths, "installed",
                        classmethod(lambda cls: (_ for _ in ()).throw(StopIteration())))
    for config in ({}, {"networkCapacityMbit": 1000}):
        try:
            forge_install.phase_control(_plan(**config)["plan"])
        except StopIteration:
            pass
    assert "SPARKD_NETWORK_CAPACITY_MBIT" not in ecrits[0]
    assert ecrits[1]["SPARKD_NETWORK_CAPACITY_MBIT"] == "1000"
