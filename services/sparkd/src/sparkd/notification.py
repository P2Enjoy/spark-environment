"""La notification hors bande des actions sensibles.

@spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47 (le contrat), §47.1 (où elle
      s'accroche), §47.2 (ce qui notifie, liste FERMÉE), §47.3 (le canal),
      §47.4 (ce que l'envoi porte), §47.5 (un canal injoignable ne fait jamais
      échouer un geste), §47.6 (l'échec est dit), §47.7 (ce qu'elle ne prétend
      pas) · §45.4 (elle ne prévient pas, elle DÉTECTE) · §21.2 (aucun secret) ·
      §37.4.5 (une panne de traçabilité ne devient pas une panne d'exploitation)

**Ce que cette fonction est, et ce qui décide de tout son code** : elle ne
prévient rien. Le geste a déjà eu lieu quand le message part. Elle sert à
DÉTECTER — y compris contre un poste compromis, que le §45.2 assume ne pas
traiter. C'est pourquoi elle n'a jamais le droit d'empêcher quoi que ce soit :
un canal muet doit rester un silence, pas une panne.
"""

from __future__ import annotations

import json
import logging
import re
import queue
import threading
import urllib.error
import urllib.request

LOG = logging.getLogger("sparkd.notification")

#: Version du format envoyé. Un destinataire qui reçoit un jour autre chose doit
#: pouvoir le voir sans deviner.
VERSION = "spark-notify-v1"

#: Le délai de garde, connexion et lecture comprises (§47.5).
DELAI_S = 5.0

#: Taille de la file. Bornée : une file sans borne transforme un canal muet en
#: fuite de mémoire, et la Forge tomberait pour une raison étrangère à son
#: travail (§47.5).
FILE_MAX = 256

#: Les actions qui notifient, et RIEN d'autre (§47.2). La liste est FERMÉE et
#: énumérée : un motif du genre « tout ce qui contient delete » laisserait passer
#: `spark.unprotect`, qui est le geste le plus grave de la liste.
ACTIONS = frozenset({
    "spark.delete",       # détruit un Spark et ses données
    "spark.unprotect",    # LÈVE une protection : le geste qui rend les autres possibles
    "snapshot.delete",    # détruit le point de retour
    "snapshot.restore",   # écrase l'état courant
    "sshkey.revoke",      # retire un accès
    "sshkey.grant",       # DONNE un accès
    "port.withdraw",      # referme un port publié
    "ingress.withdraw",   # retire un nom public
    "spark.rescue_exec",  # ouvre un shell root dans une cellule (§37.3)
})


def notifiable(action: str, result: str, actor_class: str) -> bool:
    """Cette ligne mérite-t-elle un message hors bande ? (§47.2)

    Trois refus, et chacun a son motif :

    - une action hors liste — la liste est fermée, jamais déduite ;
    - une ligne du RUNTIME : personne ne l'a demandée (§36.4), et les notifier
      noierait les neuf actions sous des dizaines d'autres. Un canal qui crie
      tout le temps n'est plus lu, et c'est la panne la plus probable de ce
      dispositif ;
    - un REFUS : rien n'a eu lieu. Le notifier apprendrait à ignorer le canal.
    """
    return (action in ACTIONS
            and result == "ok"
            and actor_class != "runtime")


def corps(ligne: dict, forge: str) -> dict:
    """Ce que l'envoi porte — et le `payload` n'y est PAS (§47.4).

    C'est là que vivent les valeurs d'un geste : corps de clé, réglages, chemins.
    Le §21.2 les caviarde déjà pour le journal ; ne pas les envoyer du tout est
    plus sûr que de les caviarder une seconde fois. Un champ qu'on n'envoie pas
    ne fuit pas.
    """
    return {
        "version": VERSION,
        "ts": ligne.get("ts"),
        # Quand plusieurs Forges écrivent dans le même canal, « un Spark a été
        # supprimé » sans dire OÙ est une alerte inexploitable.
        "forge": forge,
        "action": ligne.get("action"),
        "actor": ligne.get("actor"),
        "actor_class": ligne.get("actor_class"),
        "target_type": ligne.get("target_type"),
        "target_id": ligne.get("target_id"),
        "result": ligne.get("result"),
        "message": ligne.get("message"),
    }


#: Les champs qu'un gabarit a le droit de nommer (§47.3.1). C'est EXACTEMENT ce
#: que `corps()` publie — pas un de plus. Un gabarit ne peut donc pas faire
#: sortir ce que le §47.4 refuse de faire sortir, `payload` en tête : le nom
#: n'existe pas pour lui.
CHAMPS = ("version", "ts", "forge", "action", "actor", "actor_class",
          "target_type", "target_id", "result", "message")

#: `{champ}`. Volontairement borné aux minuscules et au souligné : un motif plus
#: large accepterait `{ }` ou `{0}` et donnerait l'illusion d'un langage.
PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def champs_inconnus(gabarit: str) -> tuple[str, ...]:
    """Les noms qu'un gabarit cite et que le §47.4 ne publie pas.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.1

    Rendu AVANT tout envoi, jamais pendant : « sinon la panne se découvre le jour
    de l'incident ». C'est la première des trois règles non négociables.
    """
    vus = [n for n in PLACEHOLDER.findall(gabarit) if n not in CHAMPS]
    return tuple(dict.fromkeys(vus))


def rendre(gabarit: str, charge: dict) -> str:
    """Le gabarit, ses `{champ}` remplacés par les valeurs de CETTE ligne.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.1

    **Substitution de texte, jamais une exécution** — deuxième règle. Il n'y a
    ici ni `eval`, ni `format`, ni moteur de gabarit : une expression régulière
    et un remplacement.

    Chaque valeur est ÉCHAPPÉE pour le contexte d'une chaîne JSON. Sans cela, un
    Spark nommé avec un guillemet casserait le document — ou pire, y injecterait
    de la structure, et le gabarit ne dessinerait plus la forme envoyée. `json`
    échappe, on retire les guillemets qu'il ajoute autour.
    """
    def remplacer(trouve: "re.Match[str]") -> str:
        valeur = charge.get(trouve.group(1))
        return json.dumps("" if valeur is None else str(valeur),
                          ensure_ascii=False)[1:-1]
    return PLACEHOLDER.sub(remplacer, gabarit)


def envoyer(url: str, charge: "dict | str", *, ouvrir=urllib.request.urlopen,
            delai: float = DELAI_S) -> None:
    """Un `POST` de JSON. Lève en cas d'échec — c'est l'appelant qui absorbe.

    `charge` est le corps du §47.4, ou le TEXTE déjà rendu par un gabarit. Le
    second n'est pas resérialisé : le gabarit dessine le document, et le
    repasser par `json` en changerait la forme, qui est précisément ce que le
    destinataire exige.
    """
    corps_brut = (charge if isinstance(charge, str)
                  else json.dumps(charge, ensure_ascii=False))
    requete = urllib.request.Request(
        url,
        data=corps_brut.encode("utf-8"),
        headers={"content-type": "application/json; charset=utf-8",
                 "user-agent": f"sparkd-notify/{VERSION}"},
        method="POST",
    )
    reponse = ouvrir(requete, timeout=delai)
    code = getattr(reponse, "status", None) or getattr(reponse, "code", 0)
    fermer = getattr(reponse, "close", None)
    if fermer:
        fermer()
    if not 200 <= int(code) < 300:
        raise urllib.error.HTTPError(url, int(code), "refusé", None, None)


class Canal:
    """Le canal hors bande, et son état visible.

    **Il ne LÈVE jamais vers l'appelant** (§47.5). `record()` doit rendre `None`
    comme avant, quoi qu'il arrive au réseau : une panne de traçabilité ne
    devient pas une panne d'exploitation (§37.4.5).

    L'envoi part dans un fil séparé, jamais dans la transaction SQLite du geste :
    un `POST` de trois secondes tenu à l'intérieur bloquerait l'unique écrivain de
    SQLite pour toute la Forge.
    """

    def __init__(self, url: str = "", forge: str = "", *,
                 gabarit: str = "", envoi=envoyer, file_max: int = FILE_MAX):
        self.url = (url or "").strip()
        self.forge = forge
        # SPK-62 · §47.3.1 : le gabarit est vérifié ICI, au chargement, donc
        # AVANT tout envoi. Un nom inconnu n'arme pas le canal — il ne le fait
        # pas non plus échouer à l'envoi, ce qui ferait découvrir la panne le
        # jour de l'incident. Le canal se dit alors « mal configuré », un
        # troisième état que l'écran distingue de « muet » et de « en échec ».
        self.gabarit = (gabarit or "").strip()
        self.gabarit_refuse: tuple[str, ...] = (
            champs_inconnus(self.gabarit) if self.gabarit else ())
        #: SPK-62 · §47.3 : d'où vient la configuration ACTUELLE — `registre` ou
        #: `environnement`. L'écran le dit : sur une Forge dont la configuration
        #: n'a pas encore été reprise au registre, il faut savoir que la régler
        #: à l'écran ne servira à rien tant que la variable est là.
        self.source = "environnement" if self.url else "registre"
        self._envoi = envoi
        self._file: queue.Queue = queue.Queue(maxsize=file_max)
        self._verrou = threading.Lock()
        self._fil: threading.Thread | None = None
        self._arret = threading.Event()
        self.sent = 0
        self.failed = 0
        self.dropped = 0
        self.last_error: str | None = None
        self.last_error_at: str | None = None

    def reregler(self, url: str, gabarit: str, source: str = "registre") -> None:
        """Reprend la configuration à chaud, sans redémarrer le service.

        @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3

        Appelée quand le registre change. La file en cours n'est PAS vidée : les
        alertes déjà déposées partent vers l'ancien destinataire, ce qui est le
        comportement voulu — elles ont été produites sous cette configuration-là,
        et les rediriger ferait arriver un geste ancien sur un canal neuf.
        """
        with self._verrou:
            self.url = (url or "").strip()
            self.gabarit = (gabarit or "").strip()
            self.gabarit_refuse = champs_inconnus(self.gabarit) if self.gabarit else ()
            self.source = source

    @property
    def configured(self) -> bool:
        return bool(self.url)

    @property
    def mal_configure(self) -> bool:
        """Une URL est posée, mais le gabarit cite un champ qui n'existe pas.

        Ce n'est PAS « muet » — quelqu'un a voulu un canal — et ce n'est pas
        « en échec » — rien n'a été tenté. Confondre les trois ferait lire
        « tout va bien » sur une Forge que personne ne surveille (§14.6).
        """
        return bool(self.url) and bool(self.gabarit_refuse)

    def etat(self) -> dict:
        """Ce que `GET /v1/forge` rend (§47.6).

        `configured: false` NE veut pas dire « tout va bien » : les compteurs
        valent alors zéro parce que rien n'est surveillé, et l'écran doit le dire
        autrement (§14.6).
        """
        with self._verrou:
            return {
                "configured": self.configured,
                "source": self.source,
                "misconfigured": self.mal_configure,
                "unknown_fields": list(self.gabarit_refuse),
                "sent": self.sent,
                "failed": self.failed,
                "dropped": self.dropped,
                "last_error": self.last_error,
                "last_error_at": self.last_error_at,
            }

    def poster(self, ligne: dict, *, maintenant=None) -> None:
        """Dépose une ligne à envoyer. Ne bloque JAMAIS, ne lève JAMAIS."""
        if not self.configured or self.mal_configure:
            return
        if not notifiable(str(ligne.get("action") or ""),
                          str(ligne.get("result") or ""),
                          str(ligne.get("actor_class") or "")):
            return
        charge = corps(ligne, self.forge)
        try:
            self._file.put_nowait(charge)
        except queue.Full:
            # Pleine, on jette le PLUS ANCIEN et on compte : les gestes récents
            # intéressent davantage que ceux d'il y a une heure, et un compteur
            # qui monte est un signal en soi.
            try:
                self._file.get_nowait()
                with self._verrou:
                    self.dropped += 1
                self._file.put_nowait(charge)
            except (queue.Empty, queue.Full):  # pragma: no cover - course rare
                with self._verrou:
                    self.dropped += 1
                return
        self._assurer_fil()

    def _assurer_fil(self) -> None:
        with self._verrou:
            if self._fil is not None and self._fil.is_alive():
                return
            self._arret.clear()
            self._fil = threading.Thread(target=self._boucle, name="sparkd-notify",
                                         daemon=True)
            self._fil.start()

    def _boucle(self) -> None:
        while not self._arret.is_set():
            try:
                charge = self._file.get(timeout=0.5)
            except queue.Empty:
                return
            self._tenter(charge)

    def _tenter(self, charge: dict) -> None:
        try:
            self._envoi(self.url,
                        rendre(self.gabarit, charge) if self.gabarit else charge)
        except Exception as erreur:  # noqa: BLE001 - AUCUNE ne remonte (§47.5)
            with self._verrou:
                self.failed += 1
                self.last_error = str(erreur) or type(erreur).__name__
                self.last_error_at = charge.get("ts")
            # Une notification qui échoue ne notifie PAS (§47.2) : sans cette
            # règle, un canal en panne produirait une boucle infinie.
            LOG.warning("notification hors bande refusée : %s", self.last_error)
        else:
            with self._verrou:
                self.sent += 1

    def vider(self, delai: float = 5.0) -> bool:
        """Attend que la file soit drainée. Pour les PREUVES, pas pour le service.

        Le service ne doit jamais attendre son canal ; une preuve, si — sans quoi
        elle mesurerait une file au lieu d'un envoi.
        """
        fil = self._fil
        if fil is None:
            return True
        fil.join(delai)
        return not fil.is_alive()
