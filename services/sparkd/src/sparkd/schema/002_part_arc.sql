-- @spec docs/BACKLOG.md#SPK-22 · docs/SCHEMA.md §5, §12 · docs/DAT.md §16.1, §27.3
-- Persiste les DEUX termes de la reserve memoire, jusqu'ici confondus.
--
-- `memory_reserve_bytes` porte leur somme. Un exploitant qui lit « 76,2 Gio
-- allouables » sur une machine de 94 Gio a besoin de savoir laquelle des deux
-- vannes tourner : abaisser `zfs_arc_max`, ou `SPARKD_MEMORY_RESERVE`. La somme
-- seule ne le dit pas.
--
-- Les deux colonnes sont a zero par defaut : une base existante conserve sa
-- reserve totale, et le prochain releve de topologie renseigne le detail.

-- @up
ALTER TABLE host ADD COLUMN memory_arc_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (memory_arc_bytes >= 0);
ALTER TABLE host ADD COLUMN memory_margin_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (memory_margin_bytes >= 0);

-- @down
ALTER TABLE host DROP COLUMN memory_margin_bytes;
ALTER TABLE host DROP COLUMN memory_arc_bytes;
