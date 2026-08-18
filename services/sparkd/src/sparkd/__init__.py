"""Runtime serveur du plan de controle Spark.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §1 (Objectif et perimetre), §10 (Decoupage du monorepo)

Ce paquet porte le runtime qui s'execute SUR la machine a decouper. Il n'est
jamais expose au reseau : son unique point d'ecoute est la boucle locale, et
seul un porteur de cle SSH l'atteint, par tunnel (docs/DAT.md §5, §6).
"""

__version__ = "0.0.0"
