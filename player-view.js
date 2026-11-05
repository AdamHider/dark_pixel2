/* ============================================================
   SECTION: PLAYER_VIEW
   Верхняя панель ресурсов и окна «Моя фракция» и «Экономика».

   Раньше это жило в main.js (секция PLAYER). Данные собирает buildModel,
   показывает UIRenderer. Прогноз на следующий ход — economy.predict: та же
   функция экономики, что считает ход, но без применения результата.

   Подключение: const view = new PlayerView(); view.setup({ game, ui, onCapital });
   ============================================================ */

// Ресурсы на земле для окна «Моя фракция»: код ресурса карты, значок, подпись.
const LAND_RESOURCES = [
    [Resource.WHEAT, '🌾', 'Пашни'], [Resource.WOOD, '🌲', 'Лес'], [Resource.IRON, '⛏️', 'Железо'], [Resource.ETHER, '🔮', 'Эфир'], [Resource.GOLD, '🪙', 'Золото']
];

class PlayerView {
    setup({ game, ui, onCapital }) {
        this.game = game;
        this.ui = ui;
        this.onCapital = onCapital;
        this.bar = document.getElementById('resources-bar');
        this.button = document.getElementById('btn-my-faction');
        this.panel = document.getElementById('my-faction');
        this.economyPanel = document.getElementById('economy');
        this.lastForecast = null;   // { turn, values }: что мы обещали на ход turn (запасы и уровень еды) — для самопроверки в checkForecast
        return this;
    }

    // Контекст СЛЕДУЮЩЕГО хода: то, что TurnManager передаст в economy.step(), когда ход будет сыгран.
    nextTurnContext() {
        const { turns } = this.game;
        const now = turns.calendar();
        const next = turns.calendar(turns.turn + 1);
        return { ...next, seasonIndex: next.seasonIndex ?? turns.options.seasons.indexOf(next.season), seasonChanged: next.season !== now.season };
    }

    buildModel() {
        const { factions, economy } = this.game;
        const player = factions && economy ? factions.playerFaction : null;
        if (!player) return null;

        const context = this.nextTurnContext();
        const next = economy.predict(player.id, context);
        const now = economy.getFactionEconomy(player.id);
        const info = factions.getFactionInfo(player.id);
        const rows = FactionEconomy.breakdown(next.report);

        // Население хранится в поселениях на карте, а не в запасах: его изменение — по клеткам прогноза.
        const populationNet = next.tiles.reduce((sum, change) => (change.population === undefined ? sum : sum + change.population - economy.population[change.index]), 0);
        const stocks = { gold: now.stockpile.gold ?? 0, production: now.stockpile.production ?? 0, population: info.population };
        const nets = { gold: next.delta.gold ?? 0, production: next.delta.production ?? 0, population: populationNet };
        const resources = {};
        for (const key of Object.keys(stocks)) resources[key] = { stock: stocks[key], net: nets[key], after: stocks[key] + nets[key], rows: rows ? rows[key] : [] };
        // Еда — не запас, а уровень около нуля: текущий и прогнозный уровень и их ярусы.
        const level = now.conditions.food ?? 0, nextLevel = next.conditions.food ?? 0;
        resources.food = { stock: level, net: nextLevel - level, after: nextLevel, tier: FactionEconomy.foodTier(level), nextTier: FactionEconomy.foodTier(nextLevel), rows: rows ? rows.food : [] };

        const season = next.report ? next.report.season : { name: '', foodMod: 1 };
        return {
            faction: { id: player.id, name: player.name, color: player.color, secondaryColor: player.secondaryColor, flag: player.flag, capitalTile: player.capitalTile },
            resources, season, holdings: now.holdings,
            territory: { regions: info.regions.filter(r => r.full).length, tiles: info.size, settlements: info.settlements.length },
            land: LAND_RESOURCES.map(([code, icon, name]) => ({ icon, name, count: info.resources[code] || 0 })),
            edicts: next.report ? next.report.edicts.active : [],
            forecastLabel: `Прогноз на ход ${context.turn}: ${season.name}, еда ×${season.foodMod}`,
            forecast: { turn: context.turn, values: { ...next.stockpile, food: nextLevel } }   // для самопроверки (checkForecast), в интерфейсе не показывается
        };
    }

    render() {
        const model = this.buildModel();
        this.lastForecast = model ? model.forecast : null;
        this.ui.renderResourcesBar(this.bar, model);
        this.ui.renderMyFactionButton(this.button, model);
        this.ui.renderMyFaction(this.panel, model, { onCapital: () => this.onCapital() });
        this.ui.renderEconomy(this.economyPanel, model);
    }

    // Самопроверка: после хода запасы игрока должны совпасть с обещанным прогнозом. Расхождение почти наверняка значит, что
    // nextTurnContext отдаёт не то, что TurnManager передаёт в step() (другой номер хода или сезон), или формула недетерминирована.
    checkForecast() {
        const { economy, turns } = this.game;
        if (!this.lastForecast || turns.turn !== this.lastForecast.turn) return;
        const actual = economy.getPlayerEconomy();
        if (!actual) return;
        const values = { ...actual.stockpile, food: actual.conditions.food };
        const wrong = Object.entries(this.lastForecast.values).filter(([key, value]) => Math.abs(value - (values[key] ?? 0)) > 0.01);
        if (wrong.length > 0) console.warn('Прогноз экономики не совпал с ходом:', { predicted: this.lastForecast.values, actual: values });
    }
}
