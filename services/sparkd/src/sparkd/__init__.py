"""Runtime serveur du plan de controle Spark.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §1 (Objectif et perimetre), §10 (Decoupage du monorepo)

Ce paquet porte le runtime qui s'execute SUR la machine a decouper. Il n'est
jamais expose au reseau : son unique point d'ecoute est la boucle locale, et
seul un porteur de cle SSH l'atteint, par tunnel (docs/DAT.md §5, §6).
"""

from importlib.metadata import PackageNotFoundError, version as _version

try:
    #: La version vient des METADONNEES DU PAQUET, donc du commit d'ou il a ete
    #: installe (docs/DAT.md §40.4). Elle n'est plus posee a la main, et ne peut
    #: donc plus etre oubliee : c'est ce qui a produit une Forge en
    #: « 0.0.0+inconnue » le 2026-08-21.
    __version__ = _version("sparkd")
except PackageNotFoundError:   # execute depuis les sources, sans installation
    __version__ = "0.0.0+inconnue"
