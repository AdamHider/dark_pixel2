/* ============================================================
   Info — запросы: что лежит в клетке и в регионе
   ============================================================ */
{
    MapGen.Info = {
        regionTiles(map, regionId) {
            return map.landTiles.filter(i => map.regionId[i] === regionId);
        },

        // Соседство регионов: общая граница или соседи через реку (регионы на разных берегах — тоже соседи). Map: id -> Set соседей.
        graph(map) {
            const graph = new Map();
            const link = (a, b) => {
                if (a < 0 || b < 0 || a === b) return;
                graph.get(a).add(b);
                if (!graph.has(b)) graph.set(b, new Set());
                graph.get(b).add(a);
            };
            for (const i of map.landTiles) {
                const a = map.regionId[i];
                if (a < 0) continue;
                if (!graph.has(a)) graph.set(a, new Set());
                for (const j of map.neighbors8(i)) {
                    const b = map.regionId[j];
                    if (b >= 0) link(a, b);
                    else if (map.river[j] > 0) for (const k of map.neighbors8(j)) link(a, map.regionId[k]);
                }
            }
            return graph;
        },

        region(map, regionId) {
            if (regionId < 0) return null;
            const tiles = this.regionTiles(map, regionId);
            const info = {
                id: regionId,
                tiles,
                size: tiles.length,
                mountains: 0,
                riverTiles: 0,
                population: map.regionPopulation[regionId] || 0,
                settlements: map.settlements.filter(s => s.regionId === regionId),
                coastal: false,
                resources: new Array(Object.keys(Resource).length).fill(0),   // по кодам Resource (0 — клетки без ресурса)
                biomes: new Array(Object.keys(Biome).length).fill(0),         // по кодам Biome (без гор)
                owners: {},                   // id фракции -> сколько клеток региона ей принадлежит
                owner: -1                     // фракция, которой принадлежит весь регион целиком (иначе -1)
            };
            const riverTiles = new Set();
            for (const i of tiles) {
                const faction = map.tileFaction[i];
                if (faction >= 0) info.owners[faction] = (info.owners[faction] || 0) + 1;
                if (map.terrain[i] === Terrain.MOUNTAIN) info.mountains++;
                else info.biomes[map.biome[i]]++;
                for (const j of map.neighbors(i)) if (map.river[j]) riverTiles.add(j); // реки в регион не входят — считаем те, что его омывают
                info.resources[map.resource[i]]++;
                if (map.neighbors(i).some(j => !map.isLand(j))) info.coastal = true;
            }
            info.riverTiles = riverTiles.size;
            const ownerIds = Object.keys(info.owners);
            if (ownerIds.length === 1 && info.owners[ownerIds[0]] === tiles.length) info.owner = Number(ownerIds[0]);
            return info;
        },

        tile(map, x, y) {
            if (x < 0 || y < 0 || x >= map.size || y >= map.size) return null;
            const i = map.index(x, y);
            const regionId = map.regionId[i];
            const group = map.settlementGroup[i];
            return {
                x, y,
                terrain: map.terrain[i],
                biome: map.biome[i],
                temperature: map.temperature[i],
                resource: map.resource[i],
                hasRiver: map.river[i] > 0,
                riverLevel: map.river[i],
                population: map.population[i],
                settlementLevel: map.settlementLevel[i],
                settlementGroupSize: group >= 0 ? map.settlementGroups[group].tiles.length : 0,
                roadLevel: map.roadLevel[i],
                shore: map.shore[i],
                crossing: map.crossing[i],
                waterDepth: map.waterDepth[i],
                regionId,
                regionSize: regionId >= 0 ? map.regionSizes[regionId] : 0,
                growth: map.growth[i],                   // степень роста леса или поля 0..1
                factionId: map.tileFaction[i]            // -1 — клетка никому не принадлежит
            };
        }
    };
}
