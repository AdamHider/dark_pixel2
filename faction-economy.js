/* ============================================================
   SECTION: FACTION_ECONOMY
   Экономика фракции — математика из симулятора dpresources.html, подключённая к игре как функция calculate для EconomyManager.

   Четыре показателя:
     золото       — запас: налоги с населения и золотые рудники; тратится на строительство, армии, башни;
     производство — запас: лес, железная руда и эфир; тратится на население, пашни, башни и строительство;
     население    — жители поселений на карте (в запасах не хранится: растёт и убывает прямо в клетках-поселениях);
     еда          — НЕ запас, а уровень около нуля («довольство», как стабильность в EU): приход с пашен и от склада производства
                    минус еда населения и армий даёт равновесный уровень, к которому текущий уровень идёт с инерцией.
                    Еду не накопить и не потратить: она лишь двигает уровень. Уровень делится на ярусы (FACTION_ECONOMY_CONFIG.food.tiers):
                    8 и выше — сильное изобилие, от 3 — профицит, от −3 до 2 — равновесие, −4 и ниже — голод, −10 и ниже — ужасный голод.
                    Чем дальше от равновесия, тем сильнее эффект: рост населения при профиците и убыль при голоде, труд (добыча
                    производства) и налоги. А при профиците и большом населении фракция распахивает новые угодья.

   Армии и башни строит игрок (construction-manager.js): сюда они приходят числом в snapshot.holdings и стоят содержания
   (армии — еда и золото, башни — золото и производство). Эдикты (FACTION_EDICTS) игрок выбирает в регионе: они меняют выработку
   ресурсов именно в этом регионе, платя за это деградацией лесов, производством или жизнями рабочих.

   Формулы симулятора считают фракцию целиком числами «в единицах», а игра хранит данные по клеткам. Мост между ними — таблица
   FACTION_ECONOMY_CONFIG: население в формулах = жители / populationUnit; число пашен = клетки угодий / food.tilesPerFarm;
   добыча = сумма выхода клеток × production.yieldScale. Это ручки баланса: подгоняйте их, а не формулы.
   Степень роста клеток (growth) здесь только визуальная — сезонные колебания еды задают сезоны (FACTION_SEASONS).

   Подключение: new EconomyManager(map, { calculate: calculateFactionEconomy, ...FactionEconomy.managerOptions(turnsPerSeason) }).
   Контракт функции — в начале economy-manager.js. Функция чистая: всё состояние берёт из snapshot, случайность — только economyRandom.
   ============================================================ */

   const FACTION_ECONOMY_CONFIG = {
    populationUnit: 40,                       // сколько жителей в одной «единице населения» формул (в симуляторе население 40)
    initial: {
        stock: { production: 30, gold: 50 },
        conditions: { food: 0 },
        holdings: { army: 0, towers: 0 }      // армии и башни строит игрок; стартовые ставит construction manager
    },
    production: {
        laborDivisor: 40, laborMin: 0.4, laborMax: 1.2,   // труд = население / 40, но не меньше 0.4 и не больше 1.2
        yieldScale: 0.5,                      // сколько добычи даёт единица выхода клеток (ручка баланса)
        popCostCoeff: 0.02,                   // расход производства на бытовые нужды населения
        farmCostPerFarm: 1.5,                 // расход производства на обслуживание одной пашни (раньше — 2% запаса еды, но еда больше не запас)
        towerCostPerUnit: 2,                  // содержание башни
        depreciation: 0.05                    // износ склада (в симуляторе в коде 0.05, хотя в его config лежало 0.04)
    },
    food: {
        basePerFarm: 10,                      // еда с одной пашни за ход (до сезонного множителя)
        tilesPerFarm: 8,                      // сколько клеток угодий считается одной «пашней» формул (ручка баланса)
        productionBonus: 0.15,                // бонус к еде от склада производства
        productionBonusCap: 40,               // склад производства даёт бонус не выше, чем за столько (пока производству некуда уходить, склад растёт без предела)
        settleConsumption: 0.1,               // еда на единицу населения
        armyConsumption: 2,                   // еда на армию
        inertia: 0.5,                         // доля пути к равновесному уровню, которую уровень проходит за ход (1 — сразу)
        levelMin: -12, levelMax: 12,          // пределы уровня
        effects: { labor: 0.02, tax: 0.015, min: -10, max: 8 },   // каждое очко уровня (в пределах min..max) сдвигает труд и налоги на столько
        tiers: [                              // ярусы уровня; ярус — первый, чей min не больше уровня
            { key: 'abundance', min: 8, name: 'Сильное изобилие' },
            { key: 'surplus', min: 3, name: 'Профицит' },
            { key: 'balance', min: -3, name: 'Равновесие' },
            { key: 'hunger', min: -9, name: 'Голод' },
            { key: 'famine', min: -Infinity, name: 'Ужасный голод' }
        ]
    },
    population: {
        growthCoeff: 0.6,                     // прирост (в единицах) на очко уровня выше равновесия
        lossCoeff: 0.4,                       // убыль на очко уровня ниже равновесия
        maxPerSettlement: 400                 // потолок жителей в одном поселении
    },
    gold: {
        taxPerCapita: 0.15, armyMaintenance: 1.0, towerMaintenance: 0.5,
        depreciation: 0.04,                   // износ казны
        orePerTile: 2                         // золото с клетки золотой руды за ход
    },
    farmland: {                               // расширение угодий при профиците еды
        rate: 0.03,                           // ожидаемое число новых пашен за ход на очко профицита при населении populationReference
        populationReference: 40,              // население (в единицах), при котором действует rate
        maxShare: 0.25,                       // пашни не занимают больше этой доли площади региона
        maxPerTurn: 2,                        // не больше стольких новых пашен за ход
        newGrowth: 0.05,                      // с чего начинает расти новое поле
        moisture: [0.1, 0.9], temperature: [0.18, 0.85]   // где можно пахать (как у генератора)
    },
    forest: {                                 // где можно сажать лес (эдикт «Лесопосадки»; условия те же, что у генератора)
        maxShare: 0.45,                       // лес не занимает больше этой доли площади региона
        newGrowth: 0.05,
        moisture: [0.3, 1], temperature: [0.12, 0.8]
    }
};

/* Эдикты: что игрок может выбрать в регионе (по одному на регион). Поля эффектов (все необязательны):
     forestYield, oreYield, farmYield — множитель выработки леса, руд (железо, эфир, золото), пашен;
     farmUpkeep   — производство в ход на каждую пашню региона;
     drain        — доля жителей региона, гибнущая за ход (рабочая сила);
     forestClear  — шанс за ход, что лес региона вырубят начисто;
     forestPlant  — шанс за ход, что в регионе высадят новый лес (рядом с имеющимся, в пределах forest.maxShare);
     taxMult      — множитель налогов с поселений региона;
     foodShift    — сдвиг равновесного уровня еды (недовольство), пропорционально населению региона. */
const FACTION_EDICTS = {
    logging: {
        name: 'Повышенная вырубка',
        description: 'Лес даёт на 75% больше производства, но каждый ход часть леса вырубается начисто.',
        forestYield: 1.75, forestClear: 0.035
    },
    reforestation: {
        name: 'Лесопосадки',
        description: 'Лес даёт на 40% меньше производства, зато в провинции высаживаются новые леса.',
        forestYield: 0.6, forestPlant: 0.25
    },
    agrotech: {
        name: 'Усиленная агротехника',
        description: 'Пашни дают на 40% больше еды, но требуют производства (0,5 за пашню) и рабочих рук: 1% жителей провинции гибнет за ход.',
        farmYield: 1.4, farmUpkeep: 0.5, drain: 0.01
    },
    mining: {
        name: 'Усиленная добыча',
        description: 'Железо, золото и эфир дают на 40% больше, но шахты уносят 1,2% жителей провинции за ход.',
        oreYield: 1.4, drain: 0.012
    },
    tithe: {
        name: 'Сбор податей',
        description: 'Налоги с провинции на 35% выше, но недовольство тянет уровень еды вниз на 2.',
        taxMult: 1.35, foodShift: -2
    }
};

// Множитель еды по сезонам: ранняя и поздняя половина каждого сезона (имена сезонов — как в seasons.js).
const FACTION_SEASONS = {
    spring: [{ name: 'Ранняя весна (распутица)', foodMod: 0.7 }, { name: 'Поздняя весна (сев)', foodMod: 1.0 }],
    summer: [{ name: 'Раннее лето (рост)', foodMod: 1.15 }, { name: 'Позднее лето (жаркая пора)', foodMod: 1.2 }],
    autumn: [{ name: 'Ранняя осень (сбор урожая)', foodMod: 1.3 }, { name: 'Поздняя осень (заморозки)', foodMod: 0.85 }],
    winter: [{ name: 'Ранняя зима (стужа)', foodMod: 0.7 }, { name: 'Поздняя зима (метель)', foodMod: 0.5 }]
};

const FactionEconomy = {
    config: FACTION_ECONOMY_CONFIG,
    edicts: FACTION_EDICTS,
    seasons: FACTION_SEASONS,

    // Параметры для EconomyManager: стартовые запасы, состояния, армии, эдикты и длина сезона.
    managerOptions(turnsPerSeason) {
        const initial = this.config.initial;
        return {
            startStockpile: { ...initial.stock }, startConditions: { ...initial.conditions }, startHoldings: { ...initial.holdings },
            edicts: this.edicts, ...(turnsPerSeason ? { turnsPerSeason } : {})
        };
    },

    // Сезон хода: имя, множитель еды. Неизвестный сезон считается летом; вторая половина сезона — когда прошла половина его ходов.
    seasonOf(snapshot) {
        const halves = this.seasons[snapshot.season] || this.seasons.summer;
        const late = snapshot.turnInSeason * 2 >= snapshot.turnsPerSeason;
        return halves[late ? 1 : 0];
    },

    // Ярус уровня еды: { key, name }.
    foodTier(level) {
        return this.config.food.tiers.find(tier => level >= tier.min);
    },

    // Границы «равновесия» — уровни, при которых население не меняется: от min яруса «равновесие» до уровня перед ярусом «профицит».
    balanceBand() {
        const tiers = this.config.food.tiers;
        return { low: tiers.find(t => t.key === 'balance').min, high: tiers.find(t => t.key === 'surplus').min - 1 };
    },

    // Эффекты эдикта клетки (пустой объект, если эдикта нет).
    edictOf(tile) {
        return (tile.edict && this.edicts[tile.edict]) || {};
    },

    /* Вход формул из снимка фракции: население в единицах, пашни, выход производства, золотые рудники, армии, башни, уровень еды —
       и всё, что меняют эдикты (с их учётом). Выход производства — сумма по клеткам: производство из ResourceInfo плюс эфир. */
    inputs(snapshot) {
        const cfg = this.config;
        let farmTiles = 0, farmWeight = 0, productionYield = 0, goldWeight = 0, edictUpkeep = 0;
        let taxPop = 0, population = 0, drainPeople = 0, shiftPop = 0;
        for (const tile of snapshot.tiles) {
            const edict = this.edictOf(tile);
            if (tile.resource === Resource.WHEAT) {
                farmTiles++;
                farmWeight += edict.farmYield || 1;
                edictUpkeep += edict.farmUpkeep || 0;
            } else if (tile.resource === Resource.GOLD) {
                goldWeight += edict.oreYield || 1;
            } else if (tile.resource === Resource.WOOD) {
                productionYield += ResourceInfo[tile.resource].produces.production * (edict.forestYield || 1);
            } else if (tile.resource === Resource.IRON || tile.resource === Resource.ETHER) {
                const produces = ResourceInfo[tile.resource].produces;
                productionYield += ((produces.production || 0) + (produces.ether || 0)) * (edict.oreYield || 1);
            } else if (tile.resource === Resource.SETTLEMENT) {
                population += tile.population;
                taxPop += tile.population * (edict.taxMult || 1);
                drainPeople += tile.population * (edict.drain || 0);
                shiftPop += tile.population * (edict.foodShift || 0);
            }
        }
        return {
            season: this.seasonOf(snapshot),
            pop: snapshot.totals.population / cfg.populationUnit,
            farms: farmWeight / cfg.food.tilesPerFarm, plainFarms: farmTiles / cfg.food.tilesPerFarm,   // с эдиктами и без
            productionYield, goldTiles: goldWeight, edictUpkeep,
            taxMult: population > 0 ? taxPop / population : 1,                        // средний множитель налогов по населению
            foodShift: population > 0 ? shiftPop / population : 0,                    // средний сдвиг уровня еды по населению
            drainPeople,
            foodLevel: snapshot.conditions.food ?? 0, prod: snapshot.stockpile.production ?? 0, gold: snapshot.stockpile.gold ?? 0,
            army: snapshot.holdings.army, towers: snapshot.holdings.towers,
            turn: snapshot.turn
        };
    },

    /* Еда — уровень, а не запас. Равновесный уровень (target) = приход с пашен (× сезон) + бонус от склада производства
       минус еда населения и армий (плюс сдвиг от эдиктов). Уровень идёт к нему с инерцией и остаётся в пределах levelMin..levelMax.
       Эффекты уровня на труд и налоги — множители (laborMod, taxMod): голод бьёт по ним, изобилие помогает. */
    Food: {
        calculate(cfg, inputs) {
            const f = cfg.food, mod = inputs.season.foodMod;
            const plain = Math.round(f.basePerFarm * inputs.plainFarms * mod);
            const base = Math.round(f.basePerFarm * inputs.farms * mod);
            const bonus = Math.round(Math.min(inputs.prod, f.productionBonusCap) * f.productionBonus * mod);
            const settle = Math.round(inputs.pop * f.settleConsumption);
            const armyOut = inputs.army * f.armyConsumption;
            const shift = Math.round(inputs.foodShift);
            const target = base - (settle + armyOut) + bonus + shift;
            const level = Math.min(f.levelMax, Math.max(f.levelMin, Math.round(inputs.foodLevel + (target - inputs.foodLevel) * f.inertia)));
            const felt = Math.min(f.effects.max, Math.max(f.effects.min, level));   // дальше этих пределов эффект уже не растёт
            return { base: plain, edict: base - plain, bonus, settle, army: armyOut, shift, target, level, change: level - inputs.foodLevel, laborMod: 1 + felt * f.effects.labor, taxMod: 1 + felt * f.effects.tax };
        }
    },

    // Производство: добыча с клеток × труд (от населения и сытости) минус износ склада; расходы на население, пашни, башни и эдикты.
    Production: {
        calculate(cfg, inputs, { food }) {
            const p = cfg.production;
            const labor = Math.min(p.laborMax, Math.max(p.laborMin, inputs.pop / p.laborDivisor)) * food.laborMod;
            const depreciation = Math.round(inputs.prod * p.depreciation);
            const gross = Math.round(inputs.productionYield * p.yieldScale * labor - depreciation);
            const popCost = Math.round(inputs.pop * p.popCostCoeff);
            const farmCost = Math.round(inputs.plainFarms * p.farmCostPerFarm);
            const towerCost = inputs.towers * p.towerCostPerUnit;
            const edictCost = Math.round(inputs.edictUpkeep);
            return { labor, gross, popCost, farmCost, towerCost, edict: edictCost, net: gross - popCost - farmCost - towerCost - edictCost };
        }
    },

    /* Население (в единицах): вне «равновесия» уровня еды оно растёт (профицит) или убывает (голод), тем сильнее, чем дальше
       уровень от равновесия. Отдельно — потери от эдиктов (рабочие гибнут в своей провинции). */
    Population: {
        calculate(cfg, inputs, { food }) {
            const p = cfg.population, band = FactionEconomy.balanceBand();
            const excess = food.level > band.high ? food.level - band.high : food.level < band.low ? band.low - food.level : 0;   // насколько далеко от равновесия
            const growth = food.level > band.high ? Math.ceil(excess * p.growthCoeff) : 0;
            const loss = food.level < band.low ? -Math.ceil(excess * p.lossCoeff) : 0;
            const net = growth + loss;
            return { growth, loss, net, netPeople: net * cfg.populationUnit, edictPeople: Math.round(inputs.drainPeople) };
        }
    },

    // Золото: налоги с населения (× настроение от еды и эдикты, за вычетом износа казны) и золотые рудники, минус содержание армий и башен.
    Gold: {
        calculate(cfg, inputs, { food }) {
            const g = cfg.gold;
            const tax = Math.round(inputs.pop * g.taxPerCapita * food.taxMod * inputs.taxMult - Math.round(inputs.gold * g.depreciation));
            const ore = inputs.goldTiles * g.orePerTile;
            const armyOut = inputs.army * g.armyMaintenance, towerOut = inputs.towers * g.towerMaintenance;
            return { tax, ore, army: armyOut, towers: towerOut, net: tax + ore - armyOut - towerOut };
        }
    },

    /* Расширение угодий: при профиците еды и большом населении фракция распахивает новые поля — только на своих свободных клетках
       рядом с уже существующими полями и поселениями, и не больше maxShare площади региона. Ожидаемое число новых полей за ход =
       rate × (уровень сверх равновесия) × (население / populationReference); дробная часть решается детерминированным броском. */
    Farmland: {
        calculate(cfg, snapshot, inputs, { food }) {
            const f = cfg.farmland, band = FactionEconomy.balanceBand(), map = snapshot.map;
            const surplus = Math.max(0, food.level - band.high);
            const expected = f.rate * surplus * (inputs.pop / f.populationReference);
            const wanted = Math.min(f.maxPerTurn, Math.floor(expected) + (economyRandom(snapshot.turn, snapshot.faction.id, 5) < expected % 1 ? 1 : 0));
            const result = { expected, wanted, added: [], blocked: 0 };
            if (wanted === 0) return result;

            const candidates = [];
            for (const tile of snapshot.tiles) {
                if (tile.resource !== Resource.NONE || tile.scorched || tile.terrain !== Terrain.PLAIN || tile.river || map.roadLevel[tile.index] > 0) continue;
                const moisture = map.moisture[tile.index], temperature = map.temperature[tile.index];
                if (moisture < f.moisture[0] || moisture > f.moisture[1] || temperature < f.temperature[0] || temperature > f.temperature[1]) continue;
                // рядом должно быть от чего распахивать: поле или поселение (по восьми соседям, любой владелец)
                const near = map.neighbors8(tile.index).filter(j => map.resource[j] === Resource.WHEAT || map.resource[j] === Resource.SETTLEMENT).length;
                if (near === 0) continue;
                candidates.push({ index: tile.index, regionId: tile.regionId, score: near + economyRandom(snapshot.turn, tile.index, 4) * 0.5 });
            }
            candidates.sort((a, b) => b.score - a.score || a.index - b.index);

            const added = {};                                                                       // сколько новых полей в регионе уже набрано этим ходом
            for (const candidate of candidates) {
                if (result.added.length >= wanted) break;
                const stat = snapshot.regions[candidate.regionId];
                const cap = stat ? Math.floor(stat.size * f.maxShare) : 0;
                if (!stat || stat.farms + (added[candidate.regionId] || 0) + 1 > cap) { result.blocked++; continue; }
                added[candidate.regionId] = (added[candidate.regionId] || 0) + 1;
                result.added.push(candidate.index);
            }
            return result;
        }
    },

    /* Лесные эдикты: «Повышенная вырубка» каждый ход с шансом forestClear вырубает лес клетки начисто (клетка становится пустой),
       «Лесопосадки» с шансом forestPlant высаживают по новому лесу в регионе — на свободной клетке рядом с лесом и не выше maxShare. */
    Edicts: {
        calculate(cfg, snapshot) {
            const f = cfg.forest, map = snapshot.map;
            const result = { cleared: [], planted: [] };
            for (const tile of snapshot.tiles) {
                const edict = FactionEconomy.edictOf(tile);
                if (tile.resource === Resource.WOOD && edict.forestClear && economyRandom(snapshot.turn, tile.index, 11) < edict.forestClear) result.cleared.push(tile.index);
            }

            const planted = {};
            for (const regionId of Object.keys(snapshot.edicts)) {
                const edict = FactionEconomy.edicts[snapshot.edicts[regionId]] || {};
                const stat = snapshot.regions[regionId];
                if (!edict.forestPlant || !stat || economyRandom(snapshot.turn, Number(regionId) * 977 + snapshot.faction.id, 12) >= edict.forestPlant) continue;
                if (stat.forests + 1 > Math.floor(stat.size * f.maxShare)) continue;
                const candidates = snapshot.tiles.filter(tile => tile.regionId === Number(regionId) && tile.resource === Resource.NONE && !tile.scorched && tile.terrain === Terrain.PLAIN && !tile.river
                    && map.roadLevel[tile.index] === 0 && map.moisture[tile.index] >= f.moisture[0] && map.temperature[tile.index] >= f.temperature[0] && map.temperature[tile.index] <= f.temperature[1]
                    && map.neighbors8(tile.index).some(j => map.resource[j] === Resource.WOOD));
                if (candidates.length === 0) continue;
                const pick = candidates.reduce((best, tile) => (economyRandom(snapshot.turn, tile.index, 13) > economyRandom(snapshot.turn, best.index, 13) ? tile : best));
                result.planted.push(pick.index);
                planted[regionId] = (planted[regionId] || 0) + 1;
            }
            return result;
        }
    },

    /* Изменения клеток: рост лесов и полей по сезону (визуальный), население, новые поля, вырубка и посадки лесов. Население растёт
       и убывает во всех поселениях поровну в процентах (их сумма меняется на netPeople), плюс потери от эдиктов в их регионах;
       не меньше 1 жителя и не больше maxPerSettlement. */
    tileChanges(snapshot, population, farmland, edicts) {
        const cfg = this.config;
        const rates = seasonGrowthRates(snapshot.season);
        const cleared = new Set(edicts.cleared);
        const changes = [];
        const settlements = [];
        for (const tile of snapshot.tiles) {
            if (cleared.has(tile.index)) {
                changes.push({ index: tile.index, resource: Resource.NONE });
            } else if (tile.resource === Resource.WOOD || tile.resource === Resource.WHEAT) {
                const growth = clamp(tile.growth + (tile.resource === Resource.WOOD ? rates.forest : rates.wheat));
                if (growth !== tile.growth) changes.push({ index: tile.index, growth });
            } else if (tile.resource === Resource.SETTLEMENT) {
                settlements.push(tile);
            }
        }
        const total = settlements.reduce((sum, tile) => sum + tile.population, 0);
        if (total > 0) {
            const factor = Math.max(0, 1 + population.netPeople / total);
            for (const tile of settlements) {
                const drain = this.edictOf(tile).drain || 0;
                const value = Math.max(1, Math.min(cfg.population.maxPerSettlement, Math.round(tile.population * factor * (1 - drain))));
                if (value !== tile.population) changes.push({ index: tile.index, population: value });
            }
        }
        for (const index of farmland.added) changes.push({ index, resource: Resource.WHEAT, growth: cfg.farmland.newGrowth });
        for (const index of edicts.planted) changes.push({ index, resource: Resource.WOOD, growth: cfg.forest.newGrowth });
        return changes;
    },

    // Расчёт хода одной фракции (контракт EconomyManager.calculate). Порядок: еда задаёт эффекты, от них зависят остальные.
    calculate(snapshot) {
        const cfg = this.config;
        const inputs = this.inputs(snapshot);

        const food = this.Food.calculate(cfg, inputs);
        const production = this.Production.calculate(cfg, inputs, { food });
        const population = this.Population.calculate(cfg, inputs, { food });
        const gold = this.Gold.calculate(cfg, inputs, { food });
        const farmland = this.Farmland.calculate(cfg, snapshot, inputs, { food });
        const edicts = this.Edicts.calculate(cfg, snapshot);

        return {
            tiles: this.tileChanges(snapshot, population, farmland, edicts),
            stockpile: {
                production: Math.max(0, inputs.prod + production.net),
                gold: Math.max(0, inputs.gold + gold.net)
            },
            conditions: { food: food.level },
            income: { food: food.level, production: production.net, gold: gold.net, population: population.netPeople - population.edictPeople },
            report: {
                season: inputs.season, labor: production.labor, pop: inputs.pop, farms: inputs.farms, holdings: { army: inputs.army, towers: inputs.towers },
                food: { ...food, tier: this.foodTier(food.level) }, production, population, gold,
                farmland: { expected: farmland.expected, added: farmland.added.length, blocked: farmland.blocked },
                edicts: { cleared: edicts.cleared.length, planted: edicts.planted.length, active: Object.entries(snapshot.edicts).map(([regionId, key]) => ({ regionId: Number(regionId), key, name: (this.edicts[key] || {}).name || key })) }
            }
        };
    },

    /* Строки для окна «Экономика»: по каждому показателю — приход и расход за ход с подписями (как в симуляторе).
       Возвращает { gold: [...], food: [...], production: [...], population: [...] }; строка — { label, value } (число со знаком)
       или { label, text } (готовая подпись, например «+1»). */
    breakdown(report) {
        if (!report || !report.food) return null;
        const unit = this.config.populationUnit;
        const row = (label, value, hideZero = false) => (hideZero && value === 0 ? null : { label, value });
        const percent = mod => `${mod >= 1 ? '+' : ''}${Math.round((mod - 1) * 100)}%`;
        const land = report.farmland, edicts = report.edicts;
        return {
            gold: [
                row('Налоги с населения', report.gold.tax), row('Золотые рудники', report.gold.ore, true),
                row('Содержание армий', -report.gold.army), row('Содержание башен', -report.gold.towers),
                { label: 'Влияние сытости на налоги', text: percent(report.food.taxMod) }
            ].filter(Boolean),
            food: [
                row('Приход с пашен', report.food.base), row('Эдикты (пашни)', report.food.edict, true), row('Бонус от производства', report.food.bonus),
                row('Расход поселений', -report.food.settle), row('Расход армий', -report.food.army), row('Недовольство (эдикты)', report.food.shift, true),
                row('Равновесный уровень', report.food.target),
                land.added > 0 ? { label: 'Новые пашни', text: `+${land.added}` } : null,
                edicts.planted > 0 ? { label: 'Высажено лесов (эдикт)', text: `+${edicts.planted}` } : null
            ].filter(Boolean),
            production: [
                row('Добыча (лес, железо, эфир) за вычетом износа', report.production.gross),
                row('Бытовые нужды населения', -report.production.popCost), row('Обслуживание пашен', -report.production.farmCost),
                row('Содержание башен', -report.production.towerCost), row('Эдикты (содержание)', -report.production.edict, true),
                edicts.cleared > 0 ? { label: 'Вырублено лесов (эдикт)', text: `-${edicts.cleared}` } : null,
                { label: 'Влияние сытости на труд', text: percent(report.food.laborMod) }
            ].filter(Boolean),
            population: [
                row('Прирост (профицит еды)', report.population.growth * unit, true), row('Убыль (голод)', report.population.loss * unit, true),
                row('Потери рабочих (эдикты)', -report.population.edictPeople, true)
            ].filter(Boolean)
        };
    }
};

function calculateFactionEconomy(snapshot) {
    return FactionEconomy.calculate(snapshot);
}