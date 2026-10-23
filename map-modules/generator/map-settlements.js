/* ============================================================
   Settlements — поселения: места, группы, уровни

   Поселение — ресурс клетки (как пшеница или руда): в клетке либо оно, либо другой ресурс. Оно даёт население и золото.
   Поселения стоят ГРУППАМИ из 1–4 соседних клеток (деревня, городок), и у каждой клетки группы свой уровень 1–4 (он же число
   домиков в клетке, в painter). Вместе клетки образуют один населённый пункт.
   Население региона зависит от «обитаемости» его клеток: плодородные луга, поля, места у рек и побережья — много,
   пустыня, тундра и горы — мало. Чем больше население, тем больше клеток в группе, а населения самой клетки хватает
   на более высокий уровень. Большому региону достаётся ещё и вторая группа.
   ============================================================ */
{
    const { RARE_RESOURCES } = MapGen;
    const HABITABILITY_BY_BIOME = {
        [Biome.GRASSLAND]: 1, [Biome.SAVANNA]: 0.65, [Biome.STEPPE]: 0.6,
        [Biome.TAIGA]: 0.55, [Biome.TUNDRA]: 0.15, [Biome.DESERT]: 0.1
    };

    MapGen.Settlements = {
        defaults: {
            populationPerHabitability: 10,    // население региона = сумма «обитаемости» его клеток × это число × случайный множитель
            populationVariation: 0.9,         // разброс населения между регионами (больше — больше и крупных городов, и пустых земель)
            settlementMinPopulation: 60,      // население группы меньше этого — поселения нет
            settlementMaxGroup: 4,            // в группе (деревня, город) не больше стольких соседних клеток
            settlementGroupGrowth: 2.2,       // во сколько раз надо увеличить население, чтобы в группе стало на клетку больше
            settlementMaxLevel: 4,            // самый большой уровень клетки (он же число домиков в клетке)
            settlementTileMinPopulation: 58,  // население клетки, с которого начинается уровень 1
            settlementTileGrowth: 1.5,        // во сколько раз надо увеличить население клетки, чтобы уровень вырос на 1
            secondSettlementPopulation: 900,  // у региона с таким населением и больше будет вторая группа
            settlementSpacing: 2             // минимум клеток между группами поселений
        },

        build(map) {
            const o = map.options;
            const habitability = this.computeHabitability(map);

            const tilesByRegion = {}, sums = {};
            for (const i of map.landTiles) {
                const id = map.regionId[i];
                if (id < 0) continue; // клетки рек в регионы не входят
                (tilesByRegion[id] ||= []).push(i);
                sums[id] = (sums[id] || 0) + habitability[i];
            }

            const candidates = [];
            for (const key of Object.keys(sums)) {
                const id = Number(key);
                const gauss = (map.random() + map.random() + map.random() - 1.5) / 0.5; // ≈ нормальное распределение
                const population = Math.round(sums[id] * o.populationPerHabitability * Math.exp(gauss * o.populationVariation));
                map.regionPopulation[id] = population;
                if (population >= o.settlementMinPopulation) candidates.push({ regionId: id, population });
            }

            // Крупные группы ставим первыми: они занимают лучшие места, мелкие устраиваются вокруг.
            candidates.sort((a, b) => b.population - a.population);
            const blocked = new Uint8Array(map.terrain.length);
            for (const { regionId, population: regionPopulation } of candidates) {
                const shares = regionPopulation >= o.secondSettlementPopulation ? [0.62, 0.38] : [1];
                for (const share of shares) {
                    const population = Math.round(regionPopulation * share);
                    if (population < o.settlementMinPopulation) continue;
                    const group = this.growSettlementGroup(map, regionId, tilesByRegion[regionId], habitability, blocked, population);
                    if (group) this.commitSettlementGroup(map, group, population, blocked);
                }
            }
        },

        // Насколько клетка подходит для жизни: 0 (горы, вода) .. ~1.6 (плодородный луг у реки).
        computeHabitability(map) {
            const habitability = new Float32Array(map.terrain.length);
            for (const i of map.landTiles) {
                if (map.terrain[i] !== Terrain.PLAIN) continue;
                let value = HABITABILITY_BY_BIOME[map.biome[i]] * (0.6 + 0.4 * map.moisture[i]);
                if (map.resource[i] === Resource.WHEAT) value += 0.35;
                else if (map.resource[i] === Resource.WOOD) value += 0.1;
                if (map.neighbors(i).some(j => map.river[j] > 0)) value += 0.35;                 // вода для питья и торговли
                if (map.neighbors8(i).some(j => !map.isLand(j))) value += 0.2;                   // берег
                if (map.shore[i] === Shore.CLIFF) value -= 0.2;
                habitability[i] = clamp(value, 0, 1.6);
            }
            return habitability;
        },

        // Уровень клетки (1..settlementMaxLevel) по её населению: каждое увеличение в settlementTileGrowth раз добавляет уровень.
        settlementLevelFor(map, population) {
            const o = map.options;
            const level = 1 + Math.floor(Math.log(Math.max(1, population) / o.settlementTileMinPopulation) / Math.log(o.settlementTileGrowth));
            return clamp(level, 1, o.settlementMaxLevel);
        },

        isSettlementSite(map, i, regionId, habitability, blocked) {
            return map.terrain[i] === Terrain.PLAIN && !map.river[i] && !blocked[i] && habitability[i] > 0
                && map.regionId[i] === regionId && map.shore[i] !== Shore.CLIFF
                && !RARE_RESOURCES.has(map.resource[i]) && map.resource[i] !== Resource.SETTLEMENT;
        },

        // Выбирает лучшую клетку региона и наращивает вокруг неё группу из соседних клеток (до settlementMaxGroup).
        growSettlementGroup(map, regionId, regionTiles, habitability, blocked, population) {
            const o = map.options;
            const isSite = i => this.isSettlementSite(map, i, regionId, habitability, blocked);
            const scoreOf = i => habitability[i] + map.random() * 0.3;

            let center = -1, best = -Infinity;
            for (const i of regionTiles) {
                if (!isSite(i)) continue;
                const score = scoreOf(i);
                if (score > best) { best = score; center = i; }
            }
            if (center === -1) return null;

            const wanted = clamp(1 + Math.floor(Math.log(population / o.settlementMinPopulation) / Math.log(o.settlementGroupGrowth)), 1, o.settlementMaxGroup);
            const tiles = [center], parents = [-1], inside = new Set(tiles);
            while (tiles.length < wanted) {
                let next = -1, parent = -1, nextScore = -Infinity;
                for (const tile of tiles) {
                    for (const neighbor of map.neighbors(tile)) {
                        if (inside.has(neighbor) || !isSite(neighbor)) continue;
                        const score = scoreOf(neighbor);
                        if (score > nextScore) { nextScore = score; next = neighbor; parent = tile; }
                    }
                }
                if (next === -1) break;                                  // дальше расти некуда: вода, горы, соседний регион
                tiles.push(next);
                parents.push(parent);
                inside.add(next);
            }
            return { tiles, parents };
        },

        // Записывает группу: делит население между клетками (центр — больше всех), задаёт уровни и соединяет клетки дорожками.
        commitSettlementGroup(map, group, population, blocked) {
            const groupId = map.settlementGroups.length;
            const weights = group.tiles.map((_, k) => (k === 0 ? 1.4 : 0.6 + map.random() * 0.8));
            const total = weights.reduce((a, b) => a + b, 0);

            group.tiles.forEach((tile, k) => {
                const tilePopulation = Math.max(1, Math.round(population * weights[k] / total));
                const level = this.settlementLevelFor(map, tilePopulation);
                map.settlements.push({ id: map.settlements.length, groupId, regionId: map.regionId[tile], tile, population: tilePopulation, level, center: k === 0 });
                map.resource[tile] = Resource.SETTLEMENT;
                map.population[tile] = Math.min(65535, tilePopulation);
                map.settlementLevel[tile] = level;
                map.settlementGroup[tile] = groupId;
                if (group.parents[k] !== -1) MapGen.Roads.carveRoad(map, [group.parents[k], tile]);   // дорожка между соседними клетками группы
            });
            map.settlementGroups.push({ id: groupId, regionId: map.regionId[group.tiles[0]], tiles: group.tiles, tile: group.tiles[0], population });

            for (const tile of group.tiles) map.markSquare(blocked, tile, map.options.settlementSpacing);
        }
    };
}
