/* ============================================================
   Economy — экономика: рост, население, ресурсы

   Все остальные поля карты (рельеф, дороги, поселения как места) не меняются. Карта пересчитывает только производное: уровень
   поселения (по населению), население групп и регионов.
   ============================================================ */
{
    const { tally, isGrowing } = MapGen;

    MapGen.Economy = {
        /* Экономика: state — любое из:
             growth: Float32Array          степень роста каждой клетки 0..1 (леса, поля)
             population: Uint16Array       население каждой клетки (учитывается только у клеток с поселением)
             resourceChanges: [{ tile, resource }]   лес или поле появились или исчезли (Resource.NONE / WOOD / WHEAT)
             version
           Все остальные поля карты (рельеф, дороги, поселения как места) не меняются. Сама карта пересчитывает только производное:
           уровень поселения (по населению), население групп и регионов.
           Слушателям уходит { visualChanged }: true, если изменилось то, что видно на карте (ступень роста, уровень поселения,
           появился или исчез лес или поле) — только тогда имеет смысл перерисовывать карту. */
        apply(map, { growth, population, resourceChanges = [], version } = {}) {
            const total = map.growth.length;
            if ((growth && growth.length !== total) || (population && population.length !== total)) throw new Error('Данные экономики не подходят к этой карте');
            const allowed = [Resource.NONE, Resource.WOOD, Resource.WHEAT];
            for (const { tile, resource } of resourceChanges) {
                if (!map.isLand(tile) || !allowed.includes(resource) || !allowed.includes(map.resource[tile])) {
                    throw new Error(`Нельзя менять ресурс клетки ${tile}: можно только лес, поле или пусто`);
                }
            }

            let visual = this.applyResourceChanges(map, resourceChanges);
            if (growth) visual = this.applyGrowth(map, growth) || visual;
            if (population) visual = this.applyPopulation(map, population) || visual;

            map.economyVersion = version === undefined ? map.economyVersion + 1 : version;
            if (visual) map.visualVersion++;
            map.economyChannel.emit({ visualChanged: visual, version: map.economyVersion });
        },

        // Все три метода ниже возвращают true, если изменилось то, что видно на карте.
        applyResourceChanges(map, changes) {
            let visual = false;
            for (const { tile, resource } of changes) {
                if (map.resource[tile] === resource) continue;
                map.resource[tile] = resource;
                visual = true;
            }
            return visual;
        },

        applyGrowth(map, growth) {
            let visual = false;
            for (let i = 0; i < growth.length; i++) {
                if (!Number.isFinite(growth[i])) continue;                // нечисловое значение игнорируем, клетка остаётся как была
                const value = clamp(growth[i]);
                if (map.growth[i] === value) continue;
                if (growthStage(map.growth[i]) !== growthStage(value) && isGrowing(map.resource[i])) visual = true;
                map.growth[i] = value;
            }
            return visual;
        },

        applyPopulation(map, population) {
            let visual = false;
            const groupTotals = new Map(), regionTotals = new Map();
            for (const settlement of map.settlements) {
                const tile = settlement.tile;
                const raw = population[tile];
                const value = Number.isFinite(raw) ? clamp(Math.round(raw), 0, 65535) : map.population[tile];
                map.population[tile] = value;
                settlement.population = value;
                const level = MapGen.Settlements.settlementLevelFor(map, value);
                if (level !== map.settlementLevel[tile]) {
                    map.settlementLevel[tile] = level;
                    visual = true;
                }
                settlement.level = level;
                tally(groupTotals, settlement.groupId, value);
                tally(regionTotals, settlement.regionId, value);
            }
            for (const [groupId, sum] of groupTotals) map.settlementGroups[groupId].population = sum;
            for (const [regionId, sum] of regionTotals) map.regionPopulation[regionId] = sum;
            return visual;
        }
    };
}
