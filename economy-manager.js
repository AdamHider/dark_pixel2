/* ============================================================
   SECTION: ECONOMY_MANAGER
   EconomyManager — экономика фракций: рост лесов и полей, рост поселений, запасы.

   Отдельный от карты модуль (заготовка). Он владеет экономическим состоянием (рост клеток, население, запасы и доход
   фракций), а карте только передаёт результат (map.applyEconomyState): на карте меняется число деревьев в клетке, густота
   полей, уровень (число домов) поселений, а рендерер перерисовывает карту сам.

   Сама математика экономики — ОТДЕЛЬНАЯ ФУНКЦИЯ, которую подключают параметром calculate. Пока она не подключена, работает
   ЗАГЛУШКА (EconomyManager.placeholder): простые правила роста, чтобы весь конвейер (ход -> экономика -> карта) работал и
   был виден на карте. Её нужно заменить настоящей функцией.

   Подключать после map-generator.js (из него берутся Resource, ResourceInfo, Terrain, Biome). Владение клетками менеджер берёт
   из карты (map.tileFaction, map.factions), то есть от faction manager, но знать о нём не обязан.

   Использование:
     const economy = new EconomyManager(map, { calculate: myEconomyFunction });   // без calculate — заглушка
     turns.addPhase('economy', ctx => economy.step(ctx));                         // раз в ход
     economy.getFactionEconomy(0);                                                // запасы, доход, отчёт фракции
     economy.predictPlayer(nextTurnContext);                                      // прогноз фракции игрока на следующий ход (ничего не меняет)

   Контракт функции экономики: calculate(snapshot) -> result
   ---------------------------------------------------------
   snapshot — состояние ОДНОЙ фракции на начало хода (только читать):
     {
       turn, year, season, seasonIndex, seasonChanged,           // время игры (из контекста хода)
       faction: { id, name, color, capitalRegion, capitalTile },
       stockpile: { food, production, gold },                    // запасы фракции с прошлого хода
       holdings: { army, towers },                               // армии и башни фракции
       turnInSeason, turnsPerSeason,                             // какой по счёту ход сезона (с 0) и сколько их в сезоне
       tiles: [                                                  // все клетки фракции
         { index, x, y,
           resource,          // Resource: NONE / WOOD / WHEAT / GOLD / ETHER / IRON / SETTLEMENT
           growth,            // степень роста 0..1 (леса и поля; у остальных 0)
           population,        // население (только у клеток с поселением)
           level,             // уровень поселения 1..4 (у остальных 0)
           terrain, biome, regionId, temperature, river, coastal }
       ],
       totals: { tiles, population, resources: [число клеток по кодам Resource] },
       map                                                       // сама карта, только для чтения (соседи, регионы и т. п.)
     }
   result — что изменить (всё необязательно; клетка из tiles меняется только теми полями, которые вы указали):
     {
       tiles: [{ index, growth?, population?, resource? }],      // growth 0..1; population — только у клеток с поселением;
                                                                 // resource — NONE / WOOD / WHEAT (лес или поле появились/исчезли)
       stockpile: { food?, production?, gold?, ... },            // новые значения запасов (сливаются с прежними)
       holdings:  { army?, towers? },                            // новые армии и башни (целые числа)
       income:    { ... },                                       // доход за ход (для интерфейса и отчётов)
       report:    any                                            // любые данные для интерфейса или логов
     }
   Функция должна быть чистой: не менять snapshot и карту, не хранить состояние между вызовами (состояние — в stockpile и клетках).
   Если ваша функция устроена иначе (другие входы и выходы), её подключают через небольшой адаптер вокруг calculate.
   ============================================================ */

// Запасная таблица роста за ход по сезонам — на случай, если в seasons.js у сезона нет поля growth. Неизвестный сезон ведёт себя как лето.
const PLACEHOLDER_SEASON_RATES = Object.freeze({
    spring: { forest: 0.12, wheat: 0.30 },
    summer: { forest: 0.10, wheat: 0.30 },
    autumn: { forest: 0.05, wheat: -0.45 },   // осенью урожай убирают: поле пустеет, еда уходит в запас
    winter: { forest: 0.01, wheat: 0.0 }
});

// Скорость роста леса и поля за ход в этом сезоне: SEASONS[сезон].growth из seasons.js, а если там нет — запасная таблица выше.
function seasonGrowthRates(season) {
    const fromSeasons = typeof SEASONS !== 'undefined' && SEASONS[season] ? SEASONS[season].growth : null;
    return fromSeasons || PLACEHOLDER_SEASON_RATES[season] || PLACEHOLDER_SEASON_RATES.summer;
}

class EconomyManager {
    static get DEFAULTS() {
        return {
            calculate: null,         // функция экономики фракции (см. контракт выше); null — ЗАГЛУШКА EconomyManager.placeholder
            neutralGrowth: true,     // растить леса и поля вне владений фракций по простым природным правилам
            startStockpile: { food: 40, production: 30, gold: 50 },   // запасы новой фракции (население — не запас: оно в поселениях на карте)
            startHoldings: { army: 2, towers: 1 },                    // армии и башни новой фракции
            turnsPerSeason: 3                                         // сколько ходов длится сезон (нужно формулам: ранняя и поздняя половина сезона)
        };
    }

    constructor(map, options = {}) {
        this.options = { ...EconomyManager.DEFAULTS, ...options };
        this.listeners = new Set();
        this.version = 0;
        this.attach(map);
    }

    /* ============================================================
       SECTION: STATE
       Подключение к карте и состояние.
       ============================================================ */

    // Привязать менеджер к карте (в том числе заново сгенерированной): экономическое состояние берётся с карты.
    attach(map) {
        this.map = map;
        this.growth = Float32Array.from(map.growth);          // степень роста клеток
        this.population = Uint16Array.from(map.population);   // население клеток
        this.resource = Uint8Array.from(map.resource);        // ресурсы клеток (лес и поле могут появляться и исчезать)
        this.baseResource = Uint8Array.from(map.resource);    // ресурсы как при генерации (для сохранения)
        this.stockpiles = {};                                  // запасы фракций: { id: { food, production, gold } }
        this.holdings = {};                                    // армии и башни фракций: { id: { army, towers } }
        this.incomes = {};                                     // доход фракций за последний ход
        this.reports = {};                                     // отчёты функции экономики за последний ход
    }

    // Передать текущее состояние в карту: она пересчитает производное (уровни поселений) и сообщит, нужна ли перерисовка.
    push() {
        const changes = [];
        for (let i = 0; i < this.resource.length; i++) {
            if (this.resource[i] !== this.map.resource[i]) changes.push({ tile: i, resource: this.resource[i] });
        }
        this.version++;
        this.map.applyEconomyState({ growth: this.growth, population: this.population, resourceChanges: changes, version: this.version });
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ============================================================
       SECTION: STEP
       Один ход.
       ============================================================ */

    /* Считает экономику за ход: для каждой фракции готовит снимок, вызывает функцию экономики, проверяет и применяет результат;
       потом растит природу вне владений и передаёт состояние в карту (один раз за ход). turn — контекст хода от TurnManager
       (годится любой объект с turn, season и т. п.). Возвращает сводку: { factions: { id: { income, stockpile, report } },
       tilesChanged, visualChanged }. */
    step(turn = {}) {
        const map = this.map;
        const calculate = this.options.calculate || EconomyManager.placeholder;
        const growthBefore = Float32Array.from(this.growth), populationBefore = Uint16Array.from(this.population);
        const visualBefore = map.visualVersion;

        const summary = { factions: {}, tilesChanged: 0, visualChanged: false };
        for (const faction of map.factions) {
            const result = calculate(this.snapshotFor(faction.id, turn));
            this.applyResult(faction.id, result || {});
            summary.factions[faction.id] = { income: this.incomes[faction.id], stockpile: { ...this.stockpiles[faction.id] }, report: this.reports[faction.id] };
        }
        if (this.options.neutralGrowth) this.growNature(turn);

        for (let i = 0; i < this.growth.length; i++) if (this.growth[i] !== growthBefore[i] || this.population[i] !== populationBefore[i]) summary.tilesChanged++;
        this.push();
        summary.visualChanged = map.visualVersion !== visualBefore;
        for (const listener of [...this.listeners]) listener(summary, turn);
        return summary;
    }

    // Снимок фракции для функции экономики (структура — в описании контракта выше).
    snapshotFor(factionId, turn = {}) {
        const map = this.map, size = map.size;
        const faction = map.factions[factionId];
        const tiles = [];
        const resources = [0, 0, 0, 0, 0, 0, 0];
        let population = 0;
        for (let i = 0; i < map.tileFaction.length; i++) {
            if (map.tileFaction[i] !== factionId) continue;
            const resource = this.resource[i];
            resources[resource]++;
            population += this.population[i];
            tiles.push({
                index: i, x: i % size, y: Math.floor(i / size),
                resource,
                growth: this.growth[i],
                population: resource === Resource.SETTLEMENT ? this.population[i] : 0,
                level: resource === Resource.SETTLEMENT ? map.settlementLevel[i] : 0,
                terrain: map.terrain[i], biome: map.biome[i], regionId: map.regionId[i], temperature: map.temperature[i],
                river: map.river[i] > 0,
                coastal: map.neighbors(i).some(j => !map.isLand(j))
            });
        }
        return {
            turn: turn.turn ?? 0, year: turn.year ?? 0, season: turn.season ?? null, seasonIndex: turn.seasonIndex ?? 0, seasonChanged: !!turn.seasonChanged,
            turnInSeason: turn.turnInSeason ?? 0, turnsPerSeason: this.options.turnsPerSeason,
            faction: { ...faction },
            stockpile: { ...this.stockpileOf(factionId) },
            holdings: { ...this.holdingsOf(factionId) },
            tiles,
            totals: { tiles: tiles.length, population, resources },
            map
        };
    }

    stockpileOf(factionId) {
        if (!this.stockpiles[factionId]) this.stockpiles[factionId] = { ...this.options.startStockpile };
        return this.stockpiles[factionId];
    }

    holdingsOf(factionId) {
        if (!this.holdings[factionId]) this.holdings[factionId] = { ...this.options.startHoldings };
        return this.holdings[factionId];
    }

    /* Проверяет результат функции экономики и применяет его к состоянию менеджера. Ошибки в данных — исключения с понятным
       текстом (молча пропускать нельзя: так не заметить ошибку в формуле). Менять можно только клетки своей фракции. */
    applyResult(factionId, result) {
        const map = this.map;
        for (const change of result.tiles || []) {
            const i = change.index;
            if (!Number.isInteger(i) || i < 0 || i >= this.growth.length) throw new Error(`Экономика фракции ${factionId}: нет клетки ${i}`);
            if (map.tileFaction[i] !== factionId) throw new Error(`Экономика фракции ${factionId} меняет чужую клетку ${i}`);

            if (change.resource !== undefined) {
                const allowed = [Resource.NONE, Resource.WOOD, Resource.WHEAT];
                if (!allowed.includes(change.resource) || !allowed.includes(this.resource[i])) throw new Error(`Клетка ${i}: ресурс можно менять только между пусто, лес и поле`);
                this.resource[i] = change.resource;
                if (change.resource === Resource.NONE) this.growth[i] = 0;
                else if (change.growth === undefined && this.growth[i] === 0) this.growth[i] = 0.05;   // новый лес или поле начинают расти с малого
            }
            if (change.growth !== undefined) {
                if (!Number.isFinite(change.growth)) throw new Error(`Клетка ${i}: growth не число`);
                if (this.resource[i] === Resource.WOOD || this.resource[i] === Resource.WHEAT) this.growth[i] = clamp(change.growth);
            }
            if (change.population !== undefined) {
                if (!Number.isFinite(change.population) || change.population < 0) throw new Error(`Клетка ${i}: population должно быть числом не меньше 0`);
                if (this.resource[i] !== Resource.SETTLEMENT) throw new Error(`Клетка ${i}: население есть только у поселений`);
                this.population[i] = Math.min(65535, Math.round(change.population));
            }
        }
        const stockpile = this.stockpileOf(factionId);
        for (const [key, value] of Object.entries(result.stockpile || {})) {
            if (!Number.isFinite(value)) throw new Error(`Запас ${key} фракции ${factionId} не число`);
            stockpile[key] = value;
        }
        const holdings = this.holdingsOf(factionId);
        for (const [key, value] of Object.entries(result.holdings || {})) {
            if (!Number.isInteger(value) || value < 0) throw new Error(`${key} фракции ${factionId} должно быть целым числом не меньше 0`);
            holdings[key] = value;
        }
        this.incomes[factionId] = result.income ? { ...result.income } : {};
        this.reports[factionId] = result.report;
    }

    /* Природа вне владений фракций: леса растут по простым правилам (поля без хозяина не трогаем).
       Это не часть экономики фракций, поэтому её можно отключить (neutralGrowth: false) или заменить. */
    growNature(turn) {
        const map = this.map;
        const rate = seasonGrowthRates(turn.season).forest;
        for (let i = 0; i < this.growth.length; i++) {
            if (map.tileFaction[i] === -1 && this.resource[i] === Resource.WOOD) this.growth[i] = clamp(this.growth[i] + rate);
        }
    }

    /* ============================================================
       SECTION: READ
       Чтение.
       ============================================================ */

    // Запасы, доход за последний ход и отчёт функции экономики для фракции.
    getFactionEconomy(factionId) {
        return { stockpile: { ...this.stockpileOf(factionId) }, holdings: { ...this.holdingsOf(factionId) }, income: { ...(this.incomes[factionId] || {}) }, report: this.reports[factionId] };
    }

    // Id фракции игрока по флагу на карте (его ставит FactionManager.setPlayerFaction); -1, если не назначена.
    playerId() {
        const faction = this.map.factions.find(f => f.player);
        return faction ? faction.id : -1;
    }

    getPlayerEconomy() {
        const id = this.playerId();
        return id === -1 ? null : this.getFactionEconomy(id);
    }

    /* ============================================================
       SECTION: PREDICT
       Прогноз на следующий ход.
       ============================================================ */

    /* Что даст step() для фракции на следующем ходу, если состояние до него не изменится. Ничего не меняет: функция экономики
       по контракту чистая, а результат не применяется. Фракции считаются независимо друг от друга, поэтому прогноз точный.
       nextTurn — контекст СЛЕДУЮЩЕГО хода в том виде, в каком TurnManager передаёт его в step(): { turn, year, season,
       seasonIndex, seasonChanged } (сезон важен: осенью, например, убирают урожай). Возвращает:
       { stockpile (запасы после хода), delta (разница с текущими), holdings, income, report, tiles (изменения клеток) }. */
    predict(factionId, nextTurn = {}) {
        const calculate = this.options.calculate || EconomyManager.placeholder;
        const before = this.stockpileOf(factionId);
        const result = calculate(this.snapshotFor(factionId, nextTurn)) || {};
        const after = { ...before, ...(result.stockpile || {}) };
        const delta = {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) delta[key] = (after[key] ?? 0) - (before[key] ?? 0);
        return { stockpile: after, delta, holdings: { ...this.holdingsOf(factionId), ...(result.holdings || {}) }, income: { ...(result.income || {}) }, report: result.report, tiles: result.tiles || [] };
    }

    predictPlayer(nextTurn) {
        const id = this.playerId();
        return id === -1 ? null : this.predict(id, nextTurn);
    }

    /* ============================================================
       SECTION: SAVE
       Сохранение.
       ============================================================ */

    // Состояние для сохранения (обычный объект, годится для JSON). Хранятся только отличия от свежесгенерированной карты.
    getState() {
        const growth = {}, population = {}, resource = {};
        for (let i = 0; i < this.growth.length; i++) {
            if (this.resource[i] === Resource.WOOD || this.resource[i] === Resource.WHEAT) growth[i] = Math.round(this.growth[i] * 1000) / 1000;
            if (this.resource[i] === Resource.SETTLEMENT) population[i] = this.population[i];
            if (this.resource[i] !== this.baseResource[i]) resource[i] = this.resource[i];
        }
        return { format: 1, mapSeed: this.map.seed, version: this.version, growth, population, resource, stockpiles: JSON.parse(JSON.stringify(this.stockpiles)), holdings: JSON.parse(JSON.stringify(this.holdings)) };
    }

    setState(state) {
        if (!state || state.format !== 1) throw new Error('Неизвестный формат состояния экономики');
        if (state.mapSeed !== this.map.seed) throw new Error('Состояние сохранено для другой карты');
        this.resource.set(this.baseResource);
        for (const [tile, resource] of Object.entries(state.resource)) this.resource[tile] = resource;
        this.growth.fill(0);
        for (const [tile, value] of Object.entries(state.growth)) this.growth[tile] = value;
        for (const [tile, value] of Object.entries(state.population)) this.population[tile] = value;
        this.stockpiles = JSON.parse(JSON.stringify(state.stockpiles));
        this.holdings = JSON.parse(JSON.stringify(state.holdings || {}));
        this.push();
    }
}

/* ============================================================
   SECTION: PLACEHOLDER
   Заглушка экономики фракции (заменяется параметром calculate).
   ============================================================ */
/* ЗАГЛУШКА экономики фракции (EconomyManager.placeholder): простые правила, чтобы конвейер работал и рост был виден на карте.
   НЕ настоящая экономика — замените своей функцией (параметр calculate). Правила:
     - леса и поля растут по сезонам (скорость — SEASONS[сезон].growth из seasons.js), осенью урожай убирается (еда уходит в запас);
     - расход еды 0,4% населения за ход; если запаса хватает больше чем на 3 хода, поселения растут (до 1,5% за ход), если нет — убывают;
     - доход ресурсов: ResourceInfo.produces каждой клетки, умноженный на степень роста. */
EconomyManager.placeholder = function placeholder(snapshot) {
    const rates = seasonGrowthRates(snapshot.season);
    const stock = { food: 0, production: 0, gold: 0, ether: 0, ...snapshot.stockpile };
    const income = { food: 0, production: 0, gold: 0, ether: 0 };
    const changes = [];
    let harvested = 0;

    for (const tile of snapshot.tiles) {
        if (tile.resource === Resource.WOOD) {
            const growth = clamp(tile.growth + rates.forest);
            if (growth !== tile.growth) changes.push({ index: tile.index, growth });
            income.production += ResourceInfo[Resource.WOOD].produces.production * growth;
        } else if (tile.resource === Resource.WHEAT) {
            const growth = clamp(tile.growth + rates.wheat);
            if (growth < tile.growth) harvested += (tile.growth - growth) * 12;
            if (growth !== tile.growth) changes.push({ index: tile.index, growth });
        } else if (tile.resource === Resource.GOLD || tile.resource === Resource.IRON || tile.resource === Resource.ETHER) {
            for (const [kind, amount] of Object.entries(ResourceInfo[tile.resource].produces)) income[kind] += amount;
        } else if (tile.resource === Resource.SETTLEMENT) {
            income.gold += ResourceInfo[Resource.SETTLEMENT].produces.gold;
        }
    }
    income.food += harvested;

    const need = snapshot.totals.population * 0.004;
    stock.food = Math.max(0, stock.food + income.food - need);
    for (const kind of ['production', 'gold', 'ether']) stock[kind] += income[kind];

    const balance = clamp((stock.food - need * 3) / (need * 3 + 1), -1, 1);
    for (const tile of snapshot.tiles) {
        if (tile.resource !== Resource.SETTLEMENT) continue;
        const population = Math.max(1, Math.min(400, Math.round(tile.population * (1 + 0.015 * balance))));
        if (population !== tile.population) changes.push({ index: tile.index, population });
    }
    return { tiles: changes, stockpile: stock, income, report: { placeholder: true, harvested, foodNeed: need, growthBalance: balance } };
};