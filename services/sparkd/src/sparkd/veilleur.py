"""Veilleur des démarrages : ce que le tmpfs d'une cellule perd, reposé quelle
que soit la cause du démarrage.

@spec docs/BACKLOG.md#SPK-133 · docs/DAT.md §43.5.3 (la cellule dit elle-même
      qu'elle a démarré : le PID d'init ; le veilleur ; l'événement du runtime
      `spark.cell_started` ; ce que la décision ne fait pas), §43.5.2 (le
      fichier des secrets vit dans un tmpfs) · §52.4 (une panne ne l'arrête
      pas, comme l'historien) · §36.4 (événement du runtime)

`/run/spark/secrets` disparaît à chaque arrêt de la cellule. Le produit le
repose quand c'est LUI qui la démarre ; ce module couvre tout le reste — un
`reboot` tapé dans la cellule, un `incus restart` à la main, le redémarrage de la
Forge. Il ne suppose rien de la cause : il relève le PID du processus d'init, qui
change à chaque démarrage, et repose l'environnement quand il a changé.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

from . import audit
from .incus import IncusError, InstanceAbsente

#: Cadence du relevé, en secondes (§43.5.3). C'est la durée pendant laquelle le
#: fichier peut manquer après un démarrage hors du produit ; elle est fixée par
#: la décision, pas par un réglage.
INTERVALLE = 15.0

#: L'action journalisée quand une cellule a démarré sans que le produit l'ait
#: commandé (§43.5.3). Ligne du runtime : elle ne notifie pas (§47.2).
ACTION = "spark.cell_started"


def pid_d_init(etat: dict | None) -> int | None:
    """Le PID du processus d'init, tel que `/1.0/instances/<nom>/state` le rend.

    Une cellule arrêtée rend `0` ; un état sans PID ne dit rien. Dans les deux
    cas il n'y a rien à comparer, et la cellule est laissée pour ce passage.
    """
    pid = (etat or {}).get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    return pid


class Veilleur(threading.Thread):
    """Le relevé des PID d'init, sur son propre fil.

    `daemon`, et sa propre connexion au registre, pour les raisons de
    l'historien (§52.2) : un service qui refuse de s'arrêter coûte un
    déploiement, et SQLite interdit de partager une connexion entre fils.

    `reposer(connection, spark_id)` est le geste de l'application qui pose
    l'environnement dans une cellule — le MÊME que celui du démarrage commandé.
    Le veilleur ne sait pas ce qu'il y a dedans, et n'a pas à le savoir.
    """

    def __init__(self, *, ouvrir, incus, reposer):
        super().__init__(name="sparkd-veilleur", daemon=True)
        self._ouvrir = ouvrir
        self._incus = incus
        self._reposer = reposer
        self._arret = threading.Event()
        #: PID d'init servi en dernier, par Spark. Vide au démarrage de `sparkd` :
        #: c'est ce qui fait tout reposer après un redémarrage de la Forge.
        self._servis: dict[str, int] = {}
        #: Un verrou par Spark, tenu par un geste du produit sur ce Spark.
        self._verrous: dict[str, threading.RLock] = {}
        self._verrou_des_verrous = threading.Lock()
        #: Compte rendu du dernier passage, pour les preuves et le diagnostic.
        self.dernier: dict | None = None
        self.erreurs = 0

    def arreter(self) -> None:
        self._arret.set()

    def _verrou_de(self, spark_id: str) -> threading.RLock:
        with self._verrou_des_verrous:
            return self._verrous.setdefault(spark_id, threading.RLock())

    @contextmanager
    def geste(self, spark_id: str):
        """Un geste du produit sur ce Spark : le veilleur s'en tient à l'écart.

        Le geste démarre la cellule, repose, puis dit le PID servi (`servi`).
        Sans cette exclusion, un passage tombé entre le démarrage et ce dernier
        mot verrait un PID inconnu, reposerait une seconde fois, et
        journaliserait un démarrage « hors du produit » qui ne l'était pas.
        Le geste attend un passage en cours sur CE Spark ; un passage, lui,
        n'attend jamais un geste : il laisse le Spark au passage suivant.
        """
        with self._verrou_de(spark_id):
            yield

    def servi(self, spark_id: str, pid: int | None) -> None:
        """Le PID que le produit vient de servir lui-même (§43.5.3)."""
        if pid is None:
            return
        with self._verrou_de(spark_id):
            self._servis[spark_id] = pid

    def oublier(self, spark_id: str) -> None:
        """Un Spark supprimé ne doit pas laisser de PID derrière lui."""
        with self._verrou_de(spark_id):
            self._servis.pop(spark_id, None)

    def un_passage(self) -> dict | None:
        """Un passage complet, sur une connexion à soi. Ne lève jamais.

        Une panne ne doit pas tuer le fil : le produit cesserait de reposer les
        secrets sans que rien ne le dise (§52.4). On compte, et on retente au
        passage suivant.
        """
        try:
            connection = self._ouvrir()
        except Exception:
            self.erreurs += 1
            return None
        try:
            self.dernier = self._passage(connection)
            return self.dernier
        except Exception:
            self.erreurs += 1
            return None
        finally:
            connection.close()

    def _passage(self, connection: sqlite3.Connection) -> dict:
        compte: dict = {"releves": 0, "reposes": [], "hors_produit": [],
                        "erreurs": 0}
        sparks = connection.execute(
            "SELECT id, name, incus_name FROM spark "
            "WHERE state = 'running' AND incus_name IS NOT NULL ORDER BY name"
        ).fetchall()
        for spark in sparks:
            verrou = self._verrou_de(spark["id"])
            if not verrou.acquire(blocking=False):
                continue
            try:
                self._un_spark(connection, spark, compte)
            finally:
                verrou.release()
        return compte

    def _un_spark(self, connection, spark, compte: dict) -> None:
        try:
            pid = pid_d_init(self._incus.instance_state(spark["incus_name"]))
        except (InstanceAbsente, IncusError):
            # Une cellule perdue est un fait sur elle, que d'autres écrans
            # disent ; ce n'est pas une panne du veilleur.
            return
        if pid is None:
            return
        compte["releves"] += 1
        precedent = self._servis.get(spark["id"])
        if precedent == pid:
            return
        try:
            self._reposer(connection, spark["id"])
        except Exception:
            # Le PID n'est PAS retenu : le passage suivant retentera.
            self.erreurs += 1
            compte["erreurs"] += 1
            return
        self._servis[spark["id"]] = pid
        compte["reposes"].append(spark["name"])
        if precedent is None:
            # Premier relevé depuis le démarrage de `sparkd` : on ne sait pas
            # qui a démarré la cellule, et on ne l'invente pas.
            return
        compte["hors_produit"].append(spark["name"])
        with audit.as_runtime():
            audit.record(
                connection, None, ACTION, "ok",
                f"La cellule « {spark['name']} » a démarré hors du produit : "
                "environnement reposé.",
                target_type="spark", target_id=spark["id"],
                payload={"pid": pid, "previous_pid": precedent})

    def run(self) -> None:
        while not self._arret.is_set():
            self.un_passage()
            self._arret.wait(INTERVALLE)
