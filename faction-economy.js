/* ============================================================
   SECTION: FACTION_ECONOMY
   Экономика фракции — математика из симулятора dpresources.html, подключённая к игре как функция calculate для EconomyManager.

   Четыре ресурса: золото, еда, производство, население.
     производство = лес + железная руда + эфир (клетки фракции);
     еда          = пашни (клетки угодий);
     золото       = налоги с населения + золотые рудники;
     население    = жители поселений на карте (в запасах не хранится: растёт и убывает прямо в клетках-поселениях).
   Расходы и бонусы — как в симуляторе: население ест, армии едят и стоят золота, башни стоят золота и производства,
   производство даёт бонус к еде, труд (от населения) множит добычу.

   Формулы симулятора считают фракцию целиком числами «в единицах», а игра хранит данные по клеткам. Мост между ними — таблица
   FACTION_ECONOMY_CONFIG: население в формулах = жители / populationUnit; число пашен = клетки угодий / food.tilesPerFarm;
   добыча = сумма выхода клеток × production.yieldScale. Это ручки баланса: подгоняйте их, а не формулы.
   Степень роста клеток (growth) здесь только визуальная — сезонные колебания еды задают сезоны (FACTION_SEASONS).

   Подключение: new EconomyManager(map, { calculate: calculateFactionEconomy, ...FactionEconomy.managerOptions() }).
   Контракт функции — в начале economy-manager.js. Функция чистая: всё состояние берёт из snapshot.
   ============================================================ */

   const FACTION_ECONOMY_CONFIG = {
    populationUnit: 40,                       // сколько жителей в одной «единице населения» формул (в симуляторе население 40)
    initial: {
        stock: { food: 40, production: 30, gold: 50 },
        holdings: { army: 2, towers: 1 }
    },
    production: {
        laborDivisor: 40, laborMin: 0.4, laborMax: 1.2,   // труд = население / 40, но не меньше 0.4 и не больше 1.2
        yieldScale: 0.5,                      // сколько добычи даёт единица выхода клеток (ручка баланса)
        popCostCoeff: 0.02,                   // расход производства на бытовые нужды населения
        farmCostCoeff: 0.02,                  // расход производства на обслуживание пашен (от запаса еды)
        towerCostPerUnit: 2,                  // содержание башни
        depreciation: 0.05                    // износ склада (в симуляторе в коде 0.05, хотя в его config лежало 0.04)
    },
    food: {
        basePerFarm: 10,                      // еда с одной пашни за ход (до сезонного множителя)
        tilesPerFarm: 8,                      // сколько клеток угодий считается одной «пашней» формул (ручка баланса)
        productionBonus: 0.15,                // бонус к еде от склада производства
        settleConsumption: 0.1,               // еда на единицу населения
        armyConsumption: 2                    // еда на армию
    },
    population: {
        growthCoeff: 0.6,                     // прирост на единицу профицита еды
        lossCoeff: 0.4,                       // убыль на единицу дефицита еды
        maxPerSettlement: 400                 // потолок жителей в одном поселении
    },
    gold: {
        taxPerCapita: 0.15, armyMaintenance: 1.0, towerMaintenance: 0.5,
        depreciation: 0.04,                   // износ казны
        orePerTile: 2                         // золото с клетки золотой руды за ход
    },
    expansion: {                              // набор армий и постройка башен (интервал 0 — отключено, как в симуляторе)
        armyInterval: 0, towerInterval: 0, armyMax: 7, towerMax: 6,
        armyCost: { gold: 15, pop: 20, prod: 5 },
        towerCost: { gold: 20, prod: 12, pop: 1 }
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
    seasons: FACTION_SEASONS,

    // Параметры для EconomyManager: стартовые запасы, армии и длина сезона.
    managerOptions(turnsPerSeason) {
        return { startStockpile: { ...this.config.initial.stock }, startHoldings: { ...this.config.initial.holdings }, ...(turnsPerSeason ? { turnsPerSeason } : {}) };
    },

    // Сезон хода: имя, множитель еды. Неизвестный сезон считается летом; вторая половина сезона — когда прошла половина его ходов.
    seasonOf(snapshot) {
        const halves = this.seasons[snapshot.season] || this.seasons.summer;
        const late = snapshot.turnInSeason * 2 >= snapshot.turnsPerSeason;
        return halves[late ? 1 : 0];
    },

    /* Вход формул из снимка фракции: население в единицах, пашни, выход производства, золотые рудники, армии, башни.
       Выход производства — сумма по клеткам: производство из ResourceInfo плюс эфир (эфир теперь часть производства). */
    inputs(snapshot) {
        const cfg = this.config;
        let farmTiles = 0, productionYield = 0, goldTiles = 0;
        for (const tile of snapshot.tiles) {
            if (tile.resource === Resource.WHEAT) farmTiles++;
            else if (tile.resource === Resource.GOLD) goldTiles++;
            else if (tile.resource === Resource.WOOD || tile.resource === Resource.IRON || tile.resource === Resource.ETHER) {
                const produces = ResourceInfo[tile.resource].produces;
                productionYield += (produces.production || 0) + (produces.ether || 0);
            }
        }
        return {
            season: this.seasonOf(snapshot),
            pop: snapshot.totals.population / cfg.populationUnit,
            farms: farmTiles / cfg.food.tilesPerFarm,
            productionYield, goldTiles,
            food: snapshot.stockpile.food ?? 0, prod: snapshot.stockpile.production ?? 0, gold: snapshot.stockpile.gold ?? 0,
            army: snapshot.holdings.army, towers: snapshot.holdings.towers,
            turn: snapshot.turn
        };
    },

    // Набор армий и постройка башен по расписанию (интервалы 0 — не строим): новые армии и башни и их цена.
    Expansion: {
        calculate(cfg, inputs) {
            const e = cfg.expansion, turn = inputs.turn;
            const recruitArmy = e.armyInterval > 0 && turn > 1 && turn % e.armyInterval === 0 && inputs.army < e.armyMax ? 1 : 0;
            const buildTower = e.towerInterval > 0 && turn > 1 && turn % e.towerInterval === 0 && inputs.towers < e.towerMax ? 1 : 0;
            return {
                recruitArmy, buildTower,
                gold: recruitArmy * e.armyCost.gold + buildTower * e.towerCost.gold,
                prod: recruitArmy * e.armyCost.prod + buildTower * e.towerCost.prod,
                pop: recruitArmy * e.armyCost.pop + buildTower * e.towerCost.pop
            };
        }
    },

    // Производство: добыча с клеток × труд (от населения) минус износ склада; расходы на население, пашни, башни и набор.
    Production: {
        calculate(cfg, inputs, { towers, expansion }) {
            const p = cfg.production;
            const labor = Math.min(p.laborMax, Math.max(p.laborMin, inputs.pop / p.laborDivisor));
            const depreciation = Math.round(inputs.prod * p.depreciation);
            const gross = Math.round(inputs.productionYield * p.yieldScale * labor - depreciation);
            const popCost = Math.round(inputs.pop * p.popCostCoeff);
            const farmCost = Math.round(inputs.food * p.farmCostCoeff);
            const towerCost = towers * p.towerCostPerUnit;
            return { labor, gross, popCost, farmCost, towerCost, expansion: expansion.prod, net: gross - popCost - farmCost - towerCost - expansion.prod };
        }
    },

    // Еда: пашни × сезонный множитель плюс бонус от склада производства, минус еда населения и армий.
    Food: {
        calculate(cfg, inputs, { army }) {
            const f = cfg.food, mod = inputs.season.foodMod;
            const base = Math.round(f.basePerFarm * inputs.farms * mod);
            const bonus = Math.round(inputs.prod * f.productionBonus * mod);
            const settle = Math.round(inputs.pop * f.settleConsumption);
            const armyOut = army * f.armyConsumption;
            return { base, bonus, settle, army: armyOut, net: base - (settle + armyOut) + bonus };
        }
    },

    // Население (в единицах): прирост при профиците еды, убыль при дефиците, набор армий и башен забирает жителей.
    Population: {
        calculate(cfg, inputs, { food, expansion }) {
            const p = cfg.population;
            const growth = food.net > 0 ? Math.round(food.net * p.growthCoeff) : 0;
            const loss = food.net < 0 ? -Math.round(Math.abs(food.net) * p.lossCoeff) : 0;
            const net = growth + loss - expansion.pop;
            return { growth, loss, expansion: expansion.pop, net, netPeople: net * cfg.populationUnit };
        }
    },

    // Золото: налоги с населения (за вычетом износа казны) и золотые рудники, минус содержание армий и башен и набор.
    Gold: {
        calculate(cfg, inputs, { army, towers, expansion }) {
            const g = cfg.gold;
            const tax = Math.round(inputs.pop * g.taxPerCapita - Math.round(inputs.gold * g.depreciation));
            const ore = inputs.goldTiles * g.orePerTile;
            const armyOut = army * g.armyMaintenance, towerOut = towers * g.towerMaintenance;
            return { tax, ore, army: armyOut, towers: towerOut, expansion: expansion.gold, net: tax + ore - armyOut - towerOut - expansion.gold };
        }
    },

    /* Изменения клеток: рост лесов и полей по сезону (визуальный) и население. Население растёт и убывает во всех поселениях
       поровну в процентах (их сумма меняется на netPeople), не меньше 1 жителя и не больше maxPerSettlement. */
    tileChanges(snapshot, population) {
        const cfg = this.config;
        const rates = seasonGrowthRates(snapshot.season);
        const changes = [];
        const settlements = [];
        for (const tile of snapshot.tiles) {
            if (tile.resource === Resource.WOOD || tile.resource === Resource.WHEAT) {
                const growth = clamp(tile.growth + (tile.resource === Resource.WOOD ? rates.forest : rates.wheat));
                if (growth !== tile.growth) changes.push({ index: tile.index, growth });
            } else if (tile.resource === Resource.SETTLEMENT) {
                settlements.push(tile);
            }
        }
        const total = settlements.reduce((sum, tile) => sum + tile.population, 0);
        if (total > 0 && population.netPeople !== 0) {
            const factor = Math.max(0, 1 + population.netPeople / total);
            for (const tile of settlements) {
                const value = Math.max(1, Math.min(cfg.population.maxPerSettlement, Math.round(tile.population * factor)));
                if (value !== tile.population) changes.push({ index: tile.index, population: value });
            }
        }
        return changes;
    },

    // Расчёт хода одной фракции (контракт EconomyManager.calculate).
    calculate(snapshot) {
        const cfg = this.config;
        const inputs = this.inputs(snapshot);
        const expansion = this.Expansion.calculate(cfg, inputs);
        const army = inputs.army + expansion.recruitArmy, towers = inputs.towers + expansion.buildTower;

        const production = this.Production.calculate(cfg, inputs, { towers, expansion });
        const food = this.Food.calculate(cfg, inputs, { army });
        const population = this.Population.calculate(cfg, inputs, { food, expansion });
        const gold = this.Gold.calculate(cfg, inputs, { army, towers, expansion });

        return {
            tiles: this.tileChanges(snapshot, population),
            stockpile: {
                food: Math.max(0, inputs.food + food.net),
                production: Math.max(0, inputs.prod + production.net),
                gold: Math.max(0, inputs.gold + gold.net)
            },
            holdings: { army, towers },
            income: { food: food.net, production: production.net, gold: gold.net, population: population.netPeople },
            report: { season: inputs.season, labor: production.labor, pop: inputs.pop, farms: inputs.farms, holdings: { army, towers }, food, production, population, gold }
        };
    },

    /* Строки для окна «Экономика»: по каждому ресурсу — приход и расход за ход с подписями (как в симуляторе).
       Возвращает { gold: [{ label, value }], food: [...], production: [...], population: [...] }; value со знаком. */
    breakdown(report) {
        if (!report || !report.food) return null;
        const unit = this.config.populationUnit;
        const row = (label, value, hideZero = false) => (hideZero && value === 0 ? null : { label, value });
        return {
            gold: [
                row('Налоги с населения', report.gold.tax), row('Золотые рудники', report.gold.ore, true),
                row('Содержание армий', -report.gold.army), row('Содержание башен', -report.gold.towers), row('Набор армий и башен', -report.gold.expansion, true)
            ].filter(Boolean),
            food: [
                row('Приход с пашен', report.food.base), row('Бонус от производства', report.food.bonus),
                row('Расход поселений', -report.food.settle), row('Расход армий', -report.food.army)
            ].filter(Boolean),
            production: [
                row('Добыча (лес, железо, эфир) за вычетом износа', report.production.gross),
                row('Бытовые нужды населения', -report.production.popCost), row('Обслуживание пашен', -report.production.farmCost),
                row('Содержание башен', -report.production.towerCost), row('Набор армий и башен', -report.production.expansion, true)
            ].filter(Boolean),
            population: [
                row('Прирост (при профиците еды)', report.population.growth * unit, true), row('Убыль (голод)', report.population.loss * unit, true),
                row('Набор армий и башен', -report.population.expansion * unit, true)
            ].filter(Boolean)
        };
    }
};

function calculateFactionEconomy(snapshot) {
    return FactionEconomy.calculate(snapshot);
}