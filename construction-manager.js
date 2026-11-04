/* ============================================================
   ConstructionManager — строительство и разрушение: мосты, башни, посадка и выжигание лесов и полей. Армии — в ArmyManager.

   Зависит от EconomyManager (оплата, посадки, число армий и башен для содержания) и FactionManager (кто чем владеет); карту
   только читает, а меняет через неё же (map.applyStructureState: башни, армии, мосты) и через экономику (леса и поля).

   Использование:
     const construction = new ConstructionManager(map, { economy, factions });
     construction.seed();                                    // стартовые башни у каждой фракции
     construction.actions(factionId, tile);                  // что можно сделать на клетке: [{ action, type, label, cost, fits, ok, reason }]
     construction.build(factionId, 'bridge', tile);          // построить: 'bridge' | 'tower' | 'forest' | 'field'
     construction.demolish(factionId, tile);                 // снести постройку или выжечь лес и поле на клетке
     construction.onChange(change => ...);                   // { action, type, tile, factionId }: после любого приказа (перерисуйте карту и интерфейс)

   Приказы действуют сразу и платные (кроме сноса): золото и производство берутся из запасов, население — из поселений.
   Мост — это значение map.crossing у клетки реки: строить можно на реке внутри владений или на нейтральной, прилегающей к ним.
   Башни стоят по одной на клетке и служат крепостями: у каждой есть прочность (hp) и зона перехвата, как у армии (ArmyManager).
   Число башен уходит в экономику как holdings (содержание: золото, производство); число армий туда же передаёт ArmyManager.
   Выжженная клетка (лес или поле, снесённые в пустоту) не зарастает несколько ходов (EconomyManager: scorchedTurns).
   ============================================================ */

   class ConstructionManager {
    static get DEFAULTS() {
        return {
            costs: {                                                      // цена приказа: gold, production — из запасов, population — жители
                bridge: { gold: 25, production: 40 },                     // мост: средне производства и золота
                tower: { production: 100, gold: 30, population: 40 },     // башня: много производства, средне золота, немного жителей
                forest: { gold: 60, production: 40 },                     // посадка леса: много золота и производства (лес — это производство)
                field: { gold: 60, production: 20, population: 80 }       // распашка поля: много золота и рабочих рук (еда не тратится), немного производства
            },
            names: { bridge: 'Мост', tower: 'Башня', forest: 'Посадить лес', field: 'Распахать поле' },
            demolishNames: { bridge: 'Разрушить мост', tower: 'Снести башню', forest: 'Сжечь лес', field: 'Сжечь поле' },
            start: { towers: 1 },                                         // стартовые башни каждой фракции (ставятся рядом со столицей)
            towerHp: 100,                                                 // прочность башни (армии её осаждают, см. damageTower)
            limits: { forestShare: 0.6, fieldShare: 0.4 },                // новые леса и поля игрока не занимают больше этой доли площади региона
            forest: { moisture: [0.3, 1], temperature: [0.12, 0.8] },     // где растёт лес (как у генератора)
            field: { moisture: [0.1, 0.9], temperature: [0.18, 0.85] }    // где можно пахать
        };
    }

    constructor(map, options = {}) {
        const { economy, factions, ...rest } = options;
        if (!economy) throw new Error('ConstructionManager: нужен economy (EconomyManager)');
        this.options = { ...ConstructionManager.DEFAULTS, ...rest };
        this.economy = economy;
        this.factions = factions || null;
        this.listeners = new Set();
        this.attach(map);
    }

    /* ============================================================
       SECTION: STATE
       Подключение к карте и состояние.
       ============================================================ */

    // Привязать менеджер к карте (в том числе заново сгенерированной): построек нет, мосты — как при генерации.
    attach(map) {
        this.map = map;
        this.structures = [];                                   // башни: { type: 'tower', tile, faction, hp }
        this.baseCrossing = Uint8Array.from(map.crossing);      // мосты как при генерации (для сохранения)
        this.crossingChanges = new Map();                       // клетка -> 0 (мост разрушен) | 1 (построен)
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // Число башен фракции.
    countsOf(factionId) {
        return { towers: this.structures.filter(s => s.faction === factionId && s.type === 'tower').length };
    }

    structureAt(tile) {
        return this.structures.find(s => s.tile === tile) || null;
    }

    /* ============================================================
       SECTION: RULES
       Что где можно строить и сносить.
       ============================================================ */

    ownerOf(tile) {
        return this.map.tileFaction[tile];
    }

    // Клетка «доступна» фракции для мостов: своя или нейтральная, но рядом со своей (по четырём соседям).
    reachable(factionId, tile) {
        const owner = this.ownerOf(tile);
        if (owner === factionId) return true;
        if (owner !== -1) return false;
        const size = this.map.size, x = tile % size, y = Math.floor(tile / size);
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size && this.ownerOf((y + dy) * size + x + dx) === factionId);
    }

    // Доля региона под ресурсом (лес или поле) с учётом новой клетки — чтобы не засаживать и не распахивать регион целиком.
    shareWith(tile, resource) {
        const map = this.map, stats = this.economy.regionStats(this.economy.resource)[map.regionId[tile]];
        if (!stats) return 0;
        return ((resource === Resource.WOOD ? stats.forests : stats.farms) + 1) / stats.size;
    }

    /* Можно ли фракции построить type на клетке tile. Возвращает { fits, ok, reason, cost }:
       fits — клетка вообще подходит (геометрия и владение), ok — и средств хватает; reason — почему нельзя (если нельзя). */
    canBuild(factionId, type, tile) {
        const cost = this.options.costs[type];
        const map = this.map;
        const no = reason => ({ fits: false, ok: false, reason, cost });
        if (!cost) return no(`Неизвестная постройка «${type}»`);
        if (!(tile >= 0 && tile < map.terrain.length) || !map.isLand(tile)) return no('Здесь нет суши');

        const rule = this.rules[type].call(this, factionId, tile);
        if (rule) return no(rule);

        const afford = this.economy.canAfford(factionId, cost);
        if (!afford.ok) return { fits: true, ok: false, reason: `Не хватает: ${this.describeCost(afford.missing)}`, cost };
        return { fits: true, ok: true, reason: '', cost };
    }

    // Правила по типам: возвращают причину отказа или null, если клетка подходит.
    get rules() {
        const map = this.map;
        const isRiver = tile => map.river[tile] > 0;
        const free = tile => this.structureAt(tile) === null;
        return {
            bridge(factionId, tile) {
                if (!isRiver(tile)) return 'Мосты строят только на реках';
                if (map.crossing[tile] > 0) return 'Здесь уже есть мост';
                if (this.ownerOf(tile) !== factionId && this.ownerOf(tile) !== -1) return 'Чужая территория';
                if (!this.reachable(factionId, tile)) return 'Река не прилегает к вашим владениям';
                if (map.neighbors8(tile).some(j => map.crossing[j] > 0)) return 'Рядом уже есть мост';
                return null;
            },
            tower(factionId, tile) {
                if (this.ownerOf(tile) !== factionId) return 'Строить можно только на своей земле';
                if (map.terrain[tile] !== Terrain.PLAIN || isRiver(tile) || map.roadLevel[tile] > 0) return 'Нужна свободная равнина без реки и дороги';
                if (this.economy.resource[tile] !== Resource.NONE) return 'Клетка занята (лес, поле, поселение или ресурс)';
                return free(tile) ? null : 'Здесь уже стоит постройка';
            },
            forest(factionId, tile) { return this.plantRule(factionId, tile, Resource.WOOD); },
            field(factionId, tile) { return this.plantRule(factionId, tile, Resource.WHEAT); }
        };
    }

    // Посадка леса и распашка поля: своя пустая равнина без реки, дороги, построек и выжженной земли в подходящем климате и не выше доли региона.
    plantRule(factionId, tile, resource) {
        const map = this.map, o = this.options, wood = resource === Resource.WOOD;
        const climate = wood ? o.forest : o.field;
        if (this.ownerOf(tile) !== factionId) return 'Только на своей земле';
        if (map.terrain[tile] !== Terrain.PLAIN || map.river[tile] > 0 || map.roadLevel[tile] > 0) return 'Нужна равнина без реки и дороги';
        if (this.economy.resource[tile] !== Resource.NONE || this.structureAt(tile)) return 'Клетка занята';
        if (this.economy.scorched.has(tile)) return 'Земля выжжена: пока ничего не вырастет';
        if (map.moisture[tile] < climate.moisture[0] || map.moisture[tile] > climate.moisture[1] || map.temperature[tile] < climate.temperature[0] || map.temperature[tile] > climate.temperature[1]) {
            return wood ? 'Здесь лес не растёт (сухо или слишком холодно и жарко)' : 'Здесь нельзя пахать (сухо, мокро, холодно или жарко)';
        }
        if (this.shareWith(tile, resource) > (wood ? o.limits.forestShare : o.limits.fieldShare)) return wood ? 'В регионе и так слишком много лесов' : 'В регионе и так слишком много полей';
        return null;
    }

    // Что на клетке можно снести: { fits, type, reason }. Сначала постройка (башня, армия), потом мост, потом лес или поле.
    canDemolish(factionId, tile) {
        const map = this.map;
        const no = reason => ({ fits: false, type: null, reason });
        if (!(tile >= 0 && tile < map.terrain.length) || !map.isLand(tile)) return no('Здесь нет суши');

        const structure = this.structureAt(tile);
        if (structure) return structure.faction === factionId ? { fits: true, type: structure.type, reason: '' } : no('Чужая постройка');
        if (map.river[tile] > 0 && map.crossing[tile] > 0) return this.reachable(factionId, tile) ? { fits: true, type: 'bridge', reason: '' } : no('Мост не на вашей земле');
        const resource = this.economy.resource[tile];
        if (resource === Resource.WOOD || resource === Resource.WHEAT) {
            return this.ownerOf(tile) === factionId ? { fits: true, type: resource === Resource.WOOD ? 'forest' : 'field', reason: '' } : no('Только на своей земле');
        }
        return no('Здесь нечего сносить');
    }

    // Все приказы, уместные на клетке (для интерфейса): сначала постройки, потом снос.
    actions(factionId, tile) {
        const list = [];
        for (const type of Object.keys(this.options.costs)) {
            const check = this.canBuild(factionId, type, tile);
            if (check.fits) list.push({ action: 'build', type, label: this.options.names[type], ...check });
        }
        const demolition = this.canDemolish(factionId, tile);
        if (demolition.fits) list.push({ action: 'demolish', type: demolition.type, label: this.options.demolishNames[demolition.type], fits: true, ok: true, reason: '', cost: {} });
        return list;
    }

    // «золото 25, производство 40, жители 160».
    describeCost(cost) {
        const names = { gold: 'золото', production: 'производство', population: 'жители' };
        return Object.entries(cost).filter(([, v]) => v > 0).map(([k, v]) => `${names[k] || k} ${v}`).join(', ');
    }

    /* ============================================================
       SECTION: ORDERS
       Приказы: построить и снести.
       ============================================================ */

    // Построить type на клетке за счёт фракции. Бросает исключение с причиной, если нельзя (проверки те же, что в canBuild).
    build(factionId, type, tile) {
        const check = this.canBuild(factionId, type, tile);
        if (!check.ok) throw new Error(check.reason);
        this.economy.spend(factionId, check.cost);
        if (type === 'forest') this.economy.setResource(factionId, tile, Resource.WOOD);
        else if (type === 'field') this.economy.setResource(factionId, tile, Resource.WHEAT);
        else if (type === 'bridge') this.crossingChanges.set(tile, 1);
        else this.structures.push({ type, tile, faction: factionId, hp: this.options.towerHp });
        this.commit({ action: 'build', type, tile, factionId });
    }

    // Снести то, что стоит на клетке: башню, армию, мост, или выжечь лес и поле (сносить бесплатно, возврата нет).
    demolish(factionId, tile) {
        const check = this.canDemolish(factionId, tile);
        if (!check.fits) throw new Error(check.reason);
        const type = check.type;
        if (type === 'forest' || type === 'field') this.economy.setResource(factionId, tile, Resource.NONE);
        else if (type === 'bridge') this.crossingChanges.set(tile, 0);
        else this.structures = this.structures.filter(s => s.tile !== tile);
        this.commit({ action: 'demolish', type, tile, factionId });
    }

    /* Осада: башне наносится damage урона; при 0 прочности она разрушается. Возвращает { destroyed, hp }. Бросает исключение, если башни нет. */
    damageTower(tile, damage) {
        const tower = this.structures.find(s => s.type === 'tower' && s.tile === tile);
        if (!tower) throw new Error(`На клетке ${tile} нет башни`);
        tower.hp = Math.max(0, tower.hp - damage);
        const destroyed = tower.hp === 0;
        if (destroyed) this.structures = this.structures.filter(s => s !== tower);
        this.commit({ action: destroyed ? 'destroyed' : 'damaged', type: 'tower', tile, factionId: tower.faction });
        return { destroyed, hp: tower.hp };
    }

    /* Стартовые башни: по options.start у каждой фракции, на ближайших к столице свободных своих клетках (без оплаты).
       Вызывать один раз после генерации фракций. */
    seed() {
        const map = this.map, size = map.size;
        for (const faction of map.factions) {
            const anchor = faction.capitalTile >= 0 ? faction.capitalTile : map.tileFaction.indexOf(faction.id);
            if (anchor < 0) continue;
            const ax = anchor % size, ay = Math.floor(anchor / size);
            const spots = [];
            for (let i = 0; i < map.tileFaction.length; i++) {
                if (map.tileFaction[i] !== faction.id || this.structureAt(i) || this.rules.tower.call(this, faction.id, i)) continue;
                spots.push({ i, d: Math.hypot(i % size - ax, Math.floor(i / size) - ay) });
            }
            spots.sort((a, b) => a.d - b.d || a.i - b.i);
            for (let k = 0; k < this.options.start.towers; k++) if (spots[k]) this.structures.push({ type: 'tower', tile: spots[k].i, faction: faction.id, hp: this.options.towerHp });
        }
        this.commit({ action: 'seed', type: null, tile: -1, factionId: -1 });
    }

    /* Передать результат в карту и экономику: список башен и армий, изменившиеся мосты, число армий и башен для содержания. */
    commit(change) {
        for (const faction of this.map.factions) this.economy.setHoldings(faction.id, this.countsOf(faction.id));
        const crossingChanges = [...this.crossingChanges].map(([tile, crossing]) => ({ tile, crossing }));
        this.map.applyStructureState({ structures: this.structures.map(({ type, tile, faction }) => ({ type, tile, faction })), crossingChanges });
        for (const listener of [...this.listeners]) listener(change);
    }

    /* ============================================================
       SECTION: SAVE
       Сохранение.
       ============================================================ */

    getState() {
        return { structures: this.structures.map(s => ({ ...s })), crossings: [...this.crossingChanges] };
    }

    setState(state) {
        const reverted = [...this.crossingChanges.keys()].map(tile => ({ tile, crossing: this.baseCrossing[tile] }));
        this.structures = state.structures.map(s => ({ ...s }));
        this.crossingChanges = new Map(state.crossings);
        this.map.applyStructureState({ structures: this.structures.map(({ type, tile, faction }) => ({ type, tile, faction })), crossingChanges: [...reverted, ...[...this.crossingChanges].map(([tile, crossing]) => ({ tile, crossing }))] });
        for (const faction of this.map.factions) this.economy.setHoldings(faction.id, this.countsOf(faction.id));
        for (const listener of [...this.listeners]) listener({ action: 'load', type: null, tile: -1, factionId: -1 });
    }
}