/* ============================================================
   SECTION: ECONOMY_MANAGER
   EconomyManager — экономика фракций: рост лесов и полей, рост поселений, запасы и состояния.

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
       stockpile: { production, gold },                          // запасы фракции с прошлого хода (то, что копится)
       conditions: { food },                                     // состояния фракции (то, что не копится, а плавает около нуля; бывают отрицательными)
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
       regions: { [regionId]: { size, farms, forests } },        // регионы, в которых у фракции есть клетки: площадь и число полей и лесов В ЦЕЛОМ регионе
       edicts: { [regionId]: ключ },                             // эдикты, выбранные фракцией в своих регионах (нет эдикта — ключа нет)
       map                                                       // сама карта, только для чтения (соседи, регионы и т. п.)
     }
   result — что изменить (всё необязательно; клетка из tiles меняется только теми полями, которые вы указали):
     {
       tiles: [{ index, growth?, population?, resource? }],      // growth 0..1; population — только у клеток с поселением;
                                                                 // resource — NONE / WOOD / WHEAT (лес или поле появились/исчезли)
       stockpile: { production?, gold?, ... },                   // новые значения запасов (сливаются с прежними)
       conditions: { food? },                                    // новые значения состояний (числа любого знака, сливаются с прежними)
       holdings:  { army?, towers? },                            // новые армии и башни (целые числа)
       income:    { ... },                                       // доход за ход (для интерфейса и отчётов)
       report:    any                                            // любые данные для интерфейса или логов
     }
   Функция должна быть чистой: не менять snapshot и карту, не хранить состояние между вызовами (состояние — в stockpile, conditions и клетках).
   Случайность — только детерминированная от хода и клетки (economyRandom): иначе прогноз на следующий ход разойдётся с самим ходом.
   Если ваша функция устроена иначе (другие входы и выходы), её подключают через небольшой адаптер вокруг calculate.
   ============================================================ */

/* Детерминированное «случайное» число 0..1 от хода, клетки (или фракции) и соли. Ни Math.random, ни скрытого состояния: один и тот же
   ход всегда даёт то же число, поэтому прогноз (predict) и настоящий ход (step) совпадают. */
   function economyRandom(turn, key, salt) {
    let h = Math.imul(turn + 1, 0x9E3779B1) ^ Math.imul(key + 1, 0x85EBCA77) ^ Math.imul(salt + 1, 0xC2B2AE3D);
    h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
    h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

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
            neutralGrowth: true,     // растить леса вне владений фракций по простым природным правилам (рост и расселение)
            forestSpread: {          // расселение ничьих лесов: зрелый лес иногда занимает соседнюю свободную клетку
                chance: 0.06,        // шанс за ход для зрелого леса при скорости роста 0.1 (весной и летом; осенью и зимой почти не растёт)
                minGrowth: 0.7,      // с какой степени роста лес считается зрелым
                maxShare: 0.45,      // лес не занимает больше этой доли площади региона
                newGrowth: 0.05      // с чего начинает расти новый лес
            },
            startStockpile: { production: 30, gold: 50 },             // запасы новой фракции (население — не запас: оно в поселениях на карте)
            startConditions: { food: 0 },                             // состояния новой фракции: еда — уровень около нуля, а не запас
            startHoldings: { army: 0, towers: 0 },                    // армии и башни новой фракции (их число задаёт construction manager по построенному)
            edicts: {},                                               // описания эдиктов { ключ: {...} }: нужны, чтобы проверять ключи (обычно из FactionEconomy.managerOptions)
            edictChangeCost: { gold: 20 },                            // сколько стоит ввести эдикт (отмена бесплатна)
            scorchedTurns: 12,                                        // сколько ходов выжженная клетка не зарастает
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
        this.conditions = {};                                  // состояния фракций (не копятся, могут быть отрицательными): { id: { food } }
        this.scorched = new Map();                             // выжженная земля: клетка -> сколько ходов ещё не зарастает
        this.edicts = {};                                      // эдикты фракций по регионам: { factionId: { regionId: ключ } }
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
        for (const [tile, left] of [...this.scorched]) {
            if (left <= 1) this.scorched.delete(tile);
            else this.scorched.set(tile, left - 1);
        }

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
        const regions = this.regionStats();
        const touched = new Set();
        for (let i = 0; i < map.tileFaction.length; i++) {
            if (map.tileFaction[i] !== factionId) continue;
            if (map.regionId[i] >= 0) touched.add(map.regionId[i]);
            const resource = this.resource[i];
            resources[resource]++;
            population += this.population[i];
            tiles.push({
                index: i, x: i % size, y: Math.floor(i / size),
                resource, scorched: this.scorched.has(i), edict: this.edictOf(factionId, map.regionId[i]),
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
            conditions: { ...this.conditionsOf(factionId) },
            holdings: { ...this.holdingsOf(factionId) },
            tiles,
            totals: { tiles: tiles.length, population, resources },
            regions: Object.fromEntries([...touched].map(id => [id, regions[id]])),
            edicts: { ...(this.edicts[factionId] || {}) },
            map
        };
    }

    /* Площадь и число полей и лесов по каждому региону (по всему региону, чьи бы клетки ни были): нужно, чтобы ограничивать расселение.
       Для снимков считаем по карте (то есть на начало хода: все фракции и прогноз видят одно и то же), для расселения лесов — по
       текущему состоянию менеджера. */
    regionStats(resource = this.map.resource) {
        const map = this.map, stats = {};
        for (const [id, size] of Object.entries(map.regionSizes)) stats[id] = { size, farms: 0, forests: 0 };
        for (let i = 0; i < resource.length; i++) {
            const stat = stats[map.regionId[i]];
            if (!stat) continue;
            if (resource[i] === Resource.WHEAT) stat.farms++;
            else if (resource[i] === Resource.WOOD) stat.forests++;
        }
        return stats;
    }

    stockpileOf(factionId) {
        if (!this.stockpiles[factionId]) this.stockpiles[factionId] = { ...this.options.startStockpile };
        return this.stockpiles[factionId];
    }

    conditionsOf(factionId) {
        if (!this.conditions[factionId]) this.conditions[factionId] = { ...this.options.startConditions };
        return this.conditions[factionId];
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
        const conditions = this.conditionsOf(factionId);
        for (const [key, value] of Object.entries(result.conditions || {})) {
            if (!Number.isFinite(value)) throw new Error(`Состояние ${key} фракции ${factionId} не число`);
            conditions[key] = value;
        }
        const holdings = this.holdingsOf(factionId);
        for (const [key, value] of Object.entries(result.holdings || {})) {
            if (!Number.isInteger(value) || value < 0) throw new Error(`${key} фракции ${factionId} должно быть целым числом не меньше 0`);
            holdings[key] = value;
        }
        this.incomes[factionId] = result.income ? { ...result.income } : {};
        this.reports[factionId] = result.report;
    }

    /* Природа вне владений фракций: ничьи леса растут и расселяются (поля без хозяина не трогаем). Лес внутри владений —
       «обрабатываемый», он даёт производство и сам не расползается. Это не часть экономики фракций, поэтому её можно
       отключить (neutralGrowth: false) или заменить. */
    growNature(turn) {
        const map = this.map;
        const rate = seasonGrowthRates(turn.season).forest;
        for (let i = 0; i < this.growth.length; i++) {
            if (map.tileFaction[i] === -1 && this.resource[i] === Resource.WOOD) this.growth[i] = clamp(this.growth[i] + rate);
        }
        this.spreadForests(turn, rate);
    }

    /* Расселение ничьих лесов: зрелый лес (степень роста от minGrowth) с шансом chance (в сезон роста выше, зимой почти нет) занимает
       одну соседнюю клетку: свободную, ничью, равнину без реки и дороги, в подходящем для леса климате. Лес не занимает больше
       maxShare площади региона. Новые леса за ход не расселяются сами (решения принимаются по состоянию на начало хода). */
    spreadForests(turn, rate) {
        const map = this.map, spread = this.options.forestSpread;
        if (!spread || rate <= 0) return;
        const regions = this.regionStats(this.resource);
        const mature = [];
        for (let i = 0; i < this.resource.length; i++) {
            if (map.tileFaction[i] === -1 && this.resource[i] === Resource.WOOD && this.growth[i] >= spread.minGrowth) mature.push(i);
        }
        for (const i of mature) {
            if (economyRandom(turn.turn ?? 0, i, 1) >= spread.chance * rate / 0.1) continue;
            const options = map.neighbors(i).filter(j => this.canGrowForest(j));
            if (options.length === 0) continue;
            const target = options[Math.floor(economyRandom(turn.turn ?? 0, i, 2) * options.length)];
            const stat = regions[map.regionId[target]];
            if (stat && stat.forests + 1 > Math.floor(stat.size * spread.maxShare)) continue;
            this.resource[target] = Resource.WOOD;
            this.growth[target] = spread.newGrowth;
            if (stat) stat.forests++;
        }
    }

    // Подходит ли клетка для нового леса (те же условия, что у генератора: равнина, влажность и тепло).
    canGrowForest(i) {
        const map = this.map;
        return map.tileFaction[i] === -1 && this.resource[i] === Resource.NONE && !this.scorched.has(i) && map.terrain[i] === Terrain.PLAIN
            && map.river[i] === 0 && map.roadLevel[i] === 0
            && map.moisture[i] > 0.3 && map.temperature[i] > 0.12 && map.temperature[i] < 0.8;
    }

    /* ============================================================
       SECTION: READ
       Чтение.
       ============================================================ */

    // Запасы, доход за последний ход и отчёт функции экономики для фракции.
    getFactionEconomy(factionId) {
        return { stockpile: { ...this.stockpileOf(factionId) }, conditions: { ...this.conditionsOf(factionId) }, holdings: { ...this.holdingsOf(factionId) }, income: { ...(this.incomes[factionId] || {}) }, report: this.reports[factionId] };
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
       { stockpile (запасы после хода), delta (разница с текущими), conditions (состояния после хода), conditionsDelta, holdings,
         income, report, tiles (изменения клеток, в том числе новые поля и леса) }. */
    predict(factionId, nextTurn = {}) {
        const calculate = this.options.calculate || EconomyManager.placeholder;
        const before = this.stockpileOf(factionId);
        const result = calculate(this.snapshotFor(factionId, nextTurn)) || {};
        const after = { ...before, ...(result.stockpile || {}) };
        const delta = {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) delta[key] = (after[key] ?? 0) - (before[key] ?? 0);
        const conditionsBefore = this.conditionsOf(factionId);
        const conditions = { ...conditionsBefore, ...(result.conditions || {}) };
        const conditionsDelta = {};
        for (const key of Object.keys(conditions)) conditionsDelta[key] = conditions[key] - (conditionsBefore[key] ?? 0);
        return { stockpile: after, delta, conditions, conditionsDelta, holdings: { ...this.holdingsOf(factionId), ...(result.holdings || {}) }, income: { ...(result.income || {}) }, report: result.report, tiles: result.tiles || [] };
    }

    predictPlayer(nextTurn) {
        const id = this.playerId();
        return id === -1 ? null : this.predict(id, nextTurn);
    }

    /* ============================================================
       SECTION: ORDERS
       Приказы: оплата, посадка и выжигание, эдикты, армии и башни. Их отдаёт игрок через construction manager; действуют сразу.
       Данные меняются в менеджере и тут же передаются в карту (push), перерисовка — забота вызывающего (см. visualVersion карты).
       ============================================================ */

    // Сколько жителей у фракции (по клеткам-поселениям).
    populationOf(factionId) {
        let total = 0;
        for (let i = 0; i < this.population.length; i++) if (this.map.tileFaction[i] === factionId && this.resource[i] === Resource.SETTLEMENT) total += this.population[i];
        return total;
    }

    /* Хватает ли фракции на оплату: cost = { gold?, production?, population? } (золото и производство — из запасов, население — жители,
       при этом в каждом поселении остаётся хотя бы один). Возвращает { ok, missing: { ключ: сколько не хватает } }. */
    canAfford(factionId, cost) {
        const stock = this.stockpileOf(factionId);
        const missing = {};
        for (const key of ['gold', 'production']) if ((cost[key] || 0) > (stock[key] ?? 0)) missing[key] = cost[key] - (stock[key] ?? 0);
        if ((cost.population || 0) > this.spendablePopulation(factionId)) missing.population = cost.population - this.spendablePopulation(factionId);
        return { ok: Object.keys(missing).length === 0, missing };
    }

    spendablePopulation(factionId) {
        let total = 0;
        for (let i = 0; i < this.population.length; i++) if (this.map.tileFaction[i] === factionId && this.resource[i] === Resource.SETTLEMENT) total += this.population[i] - 1;
        return total;
    }

    // Списывает оплату (атомарно: либо всё, либо исключение). Население убирается из поселений пропорционально их размеру.
    spend(factionId, cost) {
        const check = this.canAfford(factionId, cost);
        if (!check.ok) throw new Error(`Фракции ${factionId} не хватает: ${Object.entries(check.missing).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        const stock = this.stockpileOf(factionId);
        for (const key of ['gold', 'production']) if (cost[key]) stock[key] -= cost[key];
        if (cost.population) this.drainPopulation(factionId, cost.population);
        this.push();
    }

    // Убирает people жителей из поселений фракции: доля каждого пропорциональна тому, что в нём можно взять (остаётся хотя бы один).
    drainPopulation(factionId, people) {
        const tiles = [];
        for (let i = 0; i < this.population.length; i++) if (this.map.tileFaction[i] === factionId && this.resource[i] === Resource.SETTLEMENT && this.population[i] > 1) tiles.push(i);
        const available = tiles.reduce((sum, i) => sum + this.population[i] - 1, 0);
        if (available === 0) return;
        const shares = tiles.map(i => ({ i, exact: people * (this.population[i] - 1) / available }));
        let left = people;
        for (const share of shares) { share.take = Math.floor(share.exact); left -= share.take; }
        shares.sort((a, b) => (b.exact - b.take) - (a.exact - a.take) || a.i - b.i);
        for (const share of shares) { if (left > 0) { share.take++; left--; } this.population[share.i] -= share.take; }
    }

    // Армии и башни фракции (число): их ставит и сносит construction manager, от них зависит содержание в экономике.
    setHoldings(factionId, holdings) {
        Object.assign(this.holdingsOf(factionId), holdings);
    }

    /* Посадка и выжигание: клетка фракции становится лесом, полем или пустой (resource — Resource.WOOD, WHEAT или NONE).
       Выжженная клетка (NONE после леса или поля) не зарастает scorchedTurns ходов. */
    setResource(factionId, tile, resource) {
        const allowed = [Resource.NONE, Resource.WOOD, Resource.WHEAT];
        if (!allowed.includes(resource) || !allowed.includes(this.resource[tile])) throw new Error(`Клетка ${tile}: ресурс можно менять только между пусто, лес и поле`);
        if (this.map.tileFaction[tile] !== factionId) throw new Error(`Клетка ${tile} не принадлежит фракции ${factionId}`);
        const burned = resource === Resource.NONE && this.resource[tile] !== Resource.NONE;
        this.resource[tile] = resource;
        this.growth[tile] = resource === Resource.NONE ? 0 : 0.05;
        if (burned) this.scorched.set(tile, this.options.scorchedTurns);
        if (resource !== Resource.NONE) this.scorched.delete(tile);
        this.push();
    }

    // Эдикт фракции в регионе (ключ из options.edicts; 'none' и отсутствие — без эдикта). Ввод платный, отмена бесплатна.
    edictOf(factionId, regionId) {
        return (this.edicts[factionId] || {})[regionId] || null;
    }

    setEdict(factionId, regionId, key) {
        const definitions = this.options.edicts;
        if (key !== 'none' && !definitions[key]) throw new Error(`Нет эдикта «${key}»`);
        if (!this.map.tileFaction.some((owner, i) => owner === factionId && this.map.regionId[i] === regionId)) throw new Error(`У фракции ${factionId} нет клеток в регионе ${regionId}`);
        if ((this.edictOf(factionId, regionId) || 'none') === key) return;
        if (key !== 'none') this.spend(factionId, this.options.edictChangeCost);
        this.edicts[factionId] = this.edicts[factionId] || {};
        if (key === 'none') delete this.edicts[factionId][regionId];
        else this.edicts[factionId][regionId] = key;
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
        return { format: 1, mapSeed: this.map.seed, version: this.version, growth, population, resource, stockpiles: JSON.parse(JSON.stringify(this.stockpiles)), holdings: JSON.parse(JSON.stringify(this.holdings)), conditions: JSON.parse(JSON.stringify(this.conditions)), scorched: Object.fromEntries(this.scorched), edicts: JSON.parse(JSON.stringify(this.edicts)) };
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
        this.conditions = JSON.parse(JSON.stringify(state.conditions || {}));
        this.scorched = new Map(Object.entries(state.scorched || {}).map(([tile, left]) => [Number(tile), left]));
        this.edicts = JSON.parse(JSON.stringify(state.edicts || {}));
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