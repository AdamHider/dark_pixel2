/* ============================================================
   Внешнее состояние: ход, экономика, фракции

   Карта этим не управляет: ходами, экономикой и фракциями занимаются отдельные модули (turn-manager.js,
   economy-manager.js, faction-manager.js). Они передают сюда готовое состояние, карта его хранит, показывает
   (getTileInfo / getRegionInfo, слой фракций) и оповещает подписчиков — так рендерер перерисовывается сам.
   Данные копируются: менеджер остаётся единственным владельцем состояния.
   ============================================================ */
{
    const { tally, isGrowing } = MapGen;
    MapGen.mixins.push({
        // Ход: state = { turn, year, season, seasonIndex, turnInSeason, version } — текущее время; сезон показывает рендерер.
        applyTurnState(state) {
            this.turnState = { ...state, version: state.version === undefined ? this.turnState.version + 1 : state.version };
            this.turnChannel.emit(this.turnState);
        },

        /* Экономика: state — любое из:
             growth: Float32Array          степень роста каждой клетки 0..1 (леса, поля)
             population: Uint16Array       население каждой клетки (учитывается только у клеток с поселением)
             resourceChanges: [{ tile, resource }]   лес или поле появились или исчезли (Resource.NONE / WOOD / WHEAT)
             version
           Все остальные поля карты (рельеф, дороги, поселения как места) не меняются. Сама карта пересчитывает только производное:
           уровень поселения (по населению), население групп и регионов.
           Слушателям уходит { visualChanged }: true, если изменилось то, что видно на карте (ступень роста, уровень поселения,
           появился или исчез лес или поле) — только тогда имеет смысл перерисовывать карту. */
        applyEconomyState({ growth, population, resourceChanges = [], version } = {}) {
            const total = this.growth.length;
            if ((growth && growth.length !== total) || (population && population.length !== total)) throw new Error('Данные экономики не подходят к этой карте');
            const allowed = [Resource.NONE, Resource.WOOD, Resource.WHEAT];
            for (const { tile, resource } of resourceChanges) {
                if (!this.isLand(tile) || !allowed.includes(resource) || !allowed.includes(this.resource[tile])) {
                    throw new Error(`Нельзя менять ресурс клетки ${tile}: можно только лес, поле или пусто`);
                }
            }

            let visual = this.applyResourceChanges(resourceChanges);
            if (growth) visual = this.applyGrowth(growth) || visual;
            if (population) visual = this.applyPopulation(population) || visual;

            this.economyVersion = version === undefined ? this.economyVersion + 1 : version;
            if (visual) this.visualVersion++;
            this.economyChannel.emit({ visualChanged: visual, version: this.economyVersion });
        },

        // Все три метода ниже возвращают true, если изменилось то, что видно на карте.
        applyResourceChanges(changes) {
            let visual = false;
            for (const { tile, resource } of changes) {
                if (this.resource[tile] === resource) continue;
                this.resource[tile] = resource;
                visual = true;
            }
            return visual;
        },

        applyGrowth(growth) {
            let visual = false;
            for (let i = 0; i < growth.length; i++) {
                if (!Number.isFinite(growth[i])) continue;                // нечисловое значение игнорируем, клетка остаётся как была
                const value = clamp(growth[i]);
                if (this.growth[i] === value) continue;
                if (growthStage(this.growth[i]) !== growthStage(value) && isGrowing(this.resource[i])) visual = true;
                this.growth[i] = value;
            }
            return visual;
        },

        applyPopulation(population) {
            let visual = false;
            const groupTotals = new Map(), regionTotals = new Map();
            for (const settlement of this.settlements) {
                const tile = settlement.tile;
                const raw = population[tile];
                const value = Number.isFinite(raw) ? clamp(Math.round(raw), 0, 65535) : this.population[tile];
                this.population[tile] = value;
                settlement.population = value;
                const level = this.settlementLevelFor(value);
                if (level !== this.settlementLevel[tile]) {
                    this.settlementLevel[tile] = level;
                    visual = true;
                }
                settlement.level = level;
                tally(groupTotals, settlement.groupId, value);
                tally(regionTotals, settlement.regionId, value);
            }
            for (const [groupId, sum] of groupTotals) this.settlementGroups[groupId].population = sum;
            for (const [regionId, sum] of regionTotals) this.regionPopulation[regionId] = sum;
            return visual;
        },

        // state = { factions: [{ id, name, color, capitalRegion, capitalTile }], tileFaction: Int16Array (id фракции или -1 на клетку), version }
        applyFactionState({ factions, tileFaction, version }) {
            if (!tileFaction || tileFaction.length !== this.tileFaction.length) throw new Error('tileFaction не подходит к этой карте');
            this.factions = factions.map(f => ({ ...f }));
            this.tileFaction = Int16Array.from(tileFaction);
            this.factionVersion = version === undefined ? this.factionVersion + 1 : version;
            this.factionChannel.emit(this);
        },

        // Подписки на новое состояние; каждая возвращает функцию отписки.
        onTurnState(listener) { return this.turnChannel.subscribe(listener); },
        onEconomyState(listener) { return this.economyChannel.subscribe(listener); },
        onFactionState(listener) { return this.factionChannel.subscribe(listener); }
    });
}
