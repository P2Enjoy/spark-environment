"""@verifies docs/BACKLOG.md#SPK-61 · docs/DAT.md §46.1 (l'ordre des options
            n'est pas indifférent), §46.5 (la forme de `permitopen`, tranchée par
            la mesure) · `CLAUDE.md` §11 (aucun secret dans le dépôt)

Ce que ces preuves gardent : la ligne PRODUITE est celle qui a été mesurée, et le
script refuse de recopier une clé privée.

Le VRAI script est exécuté. Il n'écrit nulle part et ne touche à aucune machine :
il rend une ligne sur la sortie standard, ce qui le rend éprouvable ici sans
`sshd` ni Forge.

Ce que ces preuves NE prouvent PAS, et c'est écrit au §46 : qu'OpenSSH interprète
cette ligne comme attendu. Cela s'est mesuré sur un `sshd` réel le 2026-08-21, et
le résultat est consigné au §46.1 et au §46.5 — le rejouer à chaque campagne
exigerait un `sshd` que cette machine n'a pas.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[3]
SCRIPT = RACINE / "scripts" / "cle-restreinte.sh"

PUBLIQUE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2exemple2FausseCleDeTest"
            " responsable@poste")


def produire(*args):
    return subprocess.run([str(SCRIPT), *args], capture_output=True,
                          text=True, timeout=20)


# --- La ligne rendue est celle qui a été MESURÉE -----------------------------

def test_la_ligne_porte_les_quatre_elements_mesures():
    vu = produire(PUBLIQUE, "9876", "/usr/local/sbin/spark-garde-ssh")
    assert vu.returncode == 0, vu.stderr
    ligne = vu.stdout.strip()
    # `restrict` d'abord : il pose tous les refus, et ce qui suit les rouvre un à
    # un. Écrit après, il annulerait `port-forwarding` (§46.1).
    assert ligne.startswith("restrict,port-forwarding,")
    assert 'permitopen="127.0.0.1:9876"' in ligne
    # MESURÉ (§46.5) : OpenSSH n'interprète aucun motif sur l'ADRESSE. Le joker
    # d'hôte avec port fixe, lui, fonctionne — et une ligne par Spark ferait
    # tomber la console à chaque création.
    assert 'permitopen="*:22"' in ligne
    # Sans `command=`, la clé lit encore tout le registre de la Forge : c'est le
    # trou du §46.1, et c'est toute la raison d'être de l'unité.
    assert 'command="/usr/local/sbin/spark-garde-ssh"' in ligne
    assert ligne.endswith(PUBLIQUE)


def test_aucune_valeur_n_est_codee_en_dur():
    vu = produire(PUBLIQUE, "9999", "/opt/garde")
    assert 'permitopen="127.0.0.1:9999"' in vu.stdout
    assert 'command="/opt/garde"' in vu.stdout
    assert "9876" not in vu.stdout


def test_les_defauts_sont_ceux_du_produit():
    vu = produire(PUBLIQUE)
    assert 'permitopen="127.0.0.1:9876"' in vu.stdout
    assert 'command="/usr/local/sbin/spark-garde-ssh"' in vu.stdout


def test_la_cle_se_lit_aussi_depuis_un_FICHIER(tmp_path):
    fichier = tmp_path / "id_ed25519.pub"
    fichier.write_text(PUBLIQUE + "\n")
    vu = produire(str(fichier))
    assert vu.returncode == 0, vu.stderr
    assert vu.stdout.strip().endswith(PUBLIQUE)


# --- Ce que le script refuse -------------------------------------------------

def test_une_cle_PRIVEE_est_refusee_sans_etre_montree(tmp_path):
    """`CLAUDE.md` §11. Une clé privée recopiée dans une ligne destinée à être
    affichée, collée et parfois versionnée est une fuite en trois gestes."""
    fichier = tmp_path / "id_ed25519"
    fichier.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n")
    vu = produire(str(fichier))
    assert vu.returncode != 0
    assert not vu.stdout.strip(), "rien ne doit sortir"
    assert "secret" not in vu.stderr, "le message ne montre pas ce qu'il a lu"
    assert "PRIVÉE" in vu.stderr


def test_ce_qui_n_est_pas_une_cle_publique_est_refuse():
    vu = produire("bonjour")
    assert vu.returncode != 0
    assert not vu.stdout.strip()


def test_un_port_qui_n_est_pas_un_entier_est_refuse():
    # Un port non validé entrerait tel quel entre les guillemets de
    # `permitopen`, et y écrirait ce qu'on veut.
    #
    # La chaîne VIDE est dans la liste, et elle n'y est pas par hasard : le
    # script rendait pour elle une ligne sur le port par défaut, silencieusement.
    # On croit avoir posé un port, on en obtient un autre, et la console ne joint
    # plus sparkd sans que rien ne l'ait dit.
    for mauvais in ("9876;rm", "abc", "", '9876" permitopen="*:*'):
        vu = produire(PUBLIQUE, mauvais)
        assert vu.returncode != 0, mauvais
        assert not vu.stdout.strip(), mauvais


def test_un_chemin_de_garde_qui_referme_le_guillemet_est_refuse():
    # Il entre entre les guillemets de `command=` : un chemin qui en porte
    # refermerait l'option et ouvrirait ce qui suit.
    for mauvais in ('/opt/g" no-pty command="/bin/sh', '/opt/mon garde', ""):
        vu = produire(PUBLIQUE, "9876", mauvais)
        assert vu.returncode != 0, mauvais
        assert not vu.stdout.strip(), mauvais


def test_sans_argument_le_script_dit_comment_s_en_servir():
    vu = produire()
    assert vu.returncode != 0
    assert "Usage" in vu.stderr
    # Le rappel qui évite la panne : la ligne seule ne suffit pas (§46.2).
    assert "AllowTcpForwarding" in vu.stderr
