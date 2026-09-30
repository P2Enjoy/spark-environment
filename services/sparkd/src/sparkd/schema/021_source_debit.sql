-- @spec docs/BACKLOG.md#SPK-135 · docs/DAT.md §5.3 bis (un débit déclaré, quand
--       aucune carte n'en annonce) · docs/SCHEMA.md §11 ter ·
--       docs/PROD_MIGRATIONS.md#OP-32
--
-- D'où vient `network_total_bps` : un port qui annonce son débit (`measured`),
-- ou `SPARKD_NETWORK_CAPACITY_MBIT` faute d'un tel port (`declared`). Une
-- capacité que personne n'a mesurée ne doit pas se lire comme une mesure.
--
-- Une base existante reçoit `measured` : jusqu'ici, un débit n'entrait au
-- registre que mesuré — le relevé refusait sinon. Aucune valeur n'est devinée.
-- Le `down` ne perd que la SOURCE, jamais le débit.

-- @up
ALTER TABLE forge ADD COLUMN network_source TEXT NOT NULL DEFAULT 'measured'
    CHECK (network_source IN ('measured', 'declared'));

-- @down
ALTER TABLE forge DROP COLUMN network_source;
