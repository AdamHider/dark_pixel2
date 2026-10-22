/* ============================================================
   Запросы: что лежит в клетке и в регионе
   ============================================================ */
{
    MapGen.mixins.push({
        regionTileList(regionId) {
            return this.landTiles.filter(i => this.regionId[i] === regionId);
        },

        // Соседство регионов: общая граница или соседи через реку (регионы на разных берегах — тоже соседи). Map: id -> Set соседей.
        regionGraph() {
            const graph = new Map();
            const link = (a, b) => {
                if (a < 0 || b < 0 || a === b) return;
                graph.get(a).add(b);
                if (!graph.has(b)) graph.set(b, new Set());
                graph.get(b).add(a);
            };
            for (const i of this.landTiles) {
                const a = this.regionId[i];
                if (a < 0) continue;
                if (!graph.has(a)) graph.set(a, new Set());
                for (const j of this.neighbors8(i)) {
                    const b = this.regionId[j];
                    if (b >= 0) link(a, b);
                    else if (this.river[j] > 0) for (const k of this.neighbors8(j)) link(a, this.regionId[k]);
                }
            }
            return graph;
        },

        getRegionInfo(regionId) {
            if (regionId < 0) return null;
            const tiles = this.regionTileList(regionId);
            const info = {
                id: regionId,
                tiles,
                size: tiles.length,
                mountains: 0,
                riverTiles: 0,
                population: this.regionPopulation[regionId] || 0,
                settlements: this.settlements.filter(s => s.regionId === regionId),
                coastal: false,
                resources: new Array(Object.keys(Resource).length).fill(0),   // по кодам Resource (0 — клетки без ресурса)
                biomes: new Array(Object.keys(Biome).length).fill(0),         // по кодам Biome (без гор)
                owners: {},                   // id фракции -> сколько клеток региона ей принадлежит
                owner: -1                     // фракция, которой принадлежит весь регион целиком (иначе -1)
            };
            const riverTiles = new Set();
            for (const i of tiles) {
                const faction = this.tileFaction[i];
                if (faction >= 0) info.owners[faction] = (info.owners[faction] || 0) + 1;
                if (this.terrain[i] === Terrain.MOUNTAIN) info.mountains++;
                else info.biomes[this.biome[i]]++;
                for (const j of this.neighbors(i)) if (this.river[j]) riverTiles.add(j); // реки в регион не входят — считаем те, что его омывают
                info.resources[this.resource[i]]++;
                if (this.neighbors(i).some(j => !this.isLand(j))) info.coastal = true;
            }
            info.riverTiles = riverTiles.size;
            const ownerIds = Object.keys(info.owners);
            if (ownerIds.length === 1 && info.owners[ownerIds[0]] === tiles.length) info.owner = Number(ownerIds[0]);
            return info;
        },

        getTileInfo(x, y) {
            if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
            const i = this.index(x, y);
            const regionId = this.regionId[i];
            const group = this.settlementGroup[i];
            return {
                x, y,
                terrain: this.terrain[i],
                biome: this.biome[i],
                temperature: this.temperature[i],
                resource: this.resource[i],
                hasRiver: this.river[i] > 0,
                riverLevel: this.river[i],
                population: this.population[i],
                settlementLevel: this.settlementLevel[i],
                settlementGroupSize: group >= 0 ? this.settlementGroups[group].tiles.length : 0,
                roadLevel: this.roadLevel[i],
                shore: this.shore[i],
                crossing: this.crossing[i],
                waterDepth: this.waterDepth[i],
                regionId,
                regionSize: regionId >= 0 ? this.regionSizes[regionId] : 0,
                growth: this.growth[i],                   // степень роста леса или поля 0..1
                factionId: this.tileFaction[i]            // -1 — клетка никому не принадлежит
            };
        },

        get landShare() {
            return this.landTiles.length / (this.size * this.size);
        },

        get regionCount() {
            return Object.keys(this.regionSizes).length;
        }
    });
}
