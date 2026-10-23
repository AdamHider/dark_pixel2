/* ============================================================
   Factions — фракции

   Фракции и владение клетками приходят от faction manager; рендерер рисует слой фракций по map.factionVersion.
   ============================================================ */
{
    MapGen.Factions = {
        // state = { factions: [{ id, name, color, capitalRegion, capitalTile }], tileFaction: Int16Array (id фракции или -1 на клетку), version }
        apply(map, { factions, tileFaction, version }) {
            if (!tileFaction || tileFaction.length !== map.tileFaction.length) throw new Error('tileFaction не подходит к этой карте');
            map.factions = factions.map(f => ({ ...f }));
            map.tileFaction = Int16Array.from(tileFaction);
            map.factionVersion = version === undefined ? map.factionVersion + 1 : version;
            map.factionChannel.emit(map);
        }
    };
}
