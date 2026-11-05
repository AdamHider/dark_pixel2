/* ============================================================
   ArmyManager — армии: найм, перемещение, атака, оккупация и захват территорий.

   Зависит от EconomyManager (оплата найма, число армий для содержания), FactionManager (кто чем владеет и кто с кем воюет) и
   ConstructionManager (башни — это крепости). Карту читает и ничего на ней не рисует: армии показывает спрайтовый рендерер объектов,
   подсветку (куда можно дойти, зона перехвата, цели) интерфейс задаёт через map.applyStructureState({ highlights }) по preview().

   Использование:
     const armies = new ArmyManager(map, { economy, factions, construction });
     armies.seed();                                          // стартовые армии в поселениях рядом со столицей
     armies.canRecruit(factionId, tile);                     // { fits, ok, reason, cost }: нанять можно только в своём поселении
     armies.recruit(factionId, tile);                        // нанять армию (новая армия двигаться начнёт со следующего хода)
     armies.preview(army);                                   // { reachable, zone, targets }: что подсветить при выборе армии
     armies.move(armyId, tile);                              // переместить (клетка из reachable)
     armies.canAttack(armyId, tile); armies.attack(armyId, tile);   // атаковать вражескую армию или башню
     armies.disband(armyId);                                 // распустить
     armies.step(turn);                                      // фаза хода: очки движения, лечение, захват (turns.addPhase('armies', ...))
     armies.onChange(change => ...);                         // { action, armyId, ... } после любого приказа и хода

   Правила:
   - Нанять армию можно только в своём поселении, по одной на клетку. Каждый ход армия получает moves очков движения.
   - Клетки стоят очков движения: равнина 1, дорога и мост 0.5, лес 1.5, горы 3; вода и река без моста непроходимы, чужие армии и
     вражеские башни не пройти. Область, куда армия может дойти, — reachable(). Вход в зону перехвата врага останавливает армию.
   - Зона перехвата (как в Total War): у армии это она сама и все соседние клетки (zone = 1), у башни — тоже. Зону врага нельзя пройти насквозь,
     а чужие клетки внутри неё не захватить.
   - Захват (occupy) — ровно та клетка, на которой стоит армия. Захватывается клетка суши, которая ещё не наша, если она ничья или принадлежит
     враждебной фракции (война) и не лежит в зоне перехвата армии или башни другой фракции. Клетки мирных и союзных фракций не захватываются.
     Захват идёт сразу после движения и боя, а также в начале каждого хода.
   - Атака: армия подходит к врагу вплотную и бьётся; потери обеих сторон зависят от силы и местности. Башню армия осаждает: у башни есть
     прочность (hp), при нуле она разрушается; пока башня стоит, её клетка (и клетки в её зоне) не захватываются.
   ============================================================ */

   class ArmyManager extends GameModule {
    static get DEFAULTS() {
        return {
            recruitCost: { population: 160, production: 15, gold: 15 },       // найм: много жителей, мало производства и золота
            start: { army: 2 },                                               // стартовые армии каждой фракции
            army: { strength: 100, moves: 4, zone: 1, heal: 10 },             // новая армия: сила (она же максимум), очки движения за ход, радиус зоны перехвата, лечение за ход на своей земле
            fortressZone: 1,                                                  // радиус зоны перехвата башни
            moveCost: { plain: 1, road: 0.5, forest: 1.5, mountain: 3 },      // сколько очков движения стоит войти в клетку
            diagonal: 1.4,                                                    // множитель стоимости по диагонали
            combat: {
                casualty: 0.5,                                                // доля силы противника, которую армия выбивает за бой
                spread: 0.1,                                                  // разброс исхода боя (детерминированный от хода и армий)
                defense: { mountain: 1.3, forest: 1.1 },                      // множитель защиты на местности
                fortressAttack: 0.6,                                          // урон башне от силы армии за бой
                fortressDamage: 15                                            // урон армии от башни за бой
            }
        };
    }

    constructor(map, options = {}) {
        super();
        const { economy, factions, construction, ...rest } = options;
        if (!economy || !construction) throw new Error('ArmyManager: нужны economy и construction');
        this.options = { ...ArmyManager.DEFAULTS, ...rest };
        this.economy = economy;
        this.factions = factions || null;
        this.construction = construction;
        this.attach(map);
    }

    /* ============================================================
       SECTION: STATE
       Подключение к карте и состояние.
       ============================================================ */

    // Привязать менеджер к карте (в том числе заново сгенерированной): армий нет.
    attach(map) {
        super.attach(map);
        this.armies = [];            // { id, faction, tile, strength, moves, movesLeft, zone }
        this.nextId = 1;
        this.turn = 0;
    }

    // Наследует onChange/emit от GameModule: перед уведомлением обновляем содержание армий в экономике.
    emit(change) {
        for (const faction of this.map.factions) this.economy.setHoldings(faction.id, { army: this.armiesOf(faction.id).length });
        super.emit(change);
    }

    get(armyId) {
        return this.armies.find(a => a.id === armyId) || null;
    }

    armyAt(tile) {
        return this.armies.find(a => a.tile === tile) || null;
    }

    armiesOf(factionId) {
        return this.armies.filter(a => a.faction === factionId);
    }

    towerAt(tile) {
        return this.construction.structures.find(s => s.type === 'tower' && s.tile === tile) || null;
    }

    isHostile(a, b) {
        return this.factions ? this.factions.isHostile(a, b) : a !== b;
    }

    /* ============================================================
       SECTION: ZONES
       Зоны перехвата армий и башен.
       ============================================================ */

    // Клетки в квадрате радиуса radius вокруг клетки (с ней самой): для радиуса 1 это девять клеток.
    zoneTiles(center, radius) {
        const size = this.map.size, cx = center % size, cy = (center - cx) / size;
        const tiles = [];
        for (let y = Math.max(0, cy - radius); y <= Math.min(size - 1, cy + radius); y++) {
            for (let x = Math.max(0, cx - radius); x <= Math.min(size - 1, cx + radius); x++) tiles.push(y * size + x);
        }
        return tiles;
    }

    /* Клетки, лежащие в зонах перехвата чужих (не фракции factionId) армий и башен. hostileOnly — учитывать только враждебные фракции
       (для движения); иначе все чужие (для захвата: нельзя отнимать клетки, пока рядом чужая армия или крепость). */
    zoneCover(factionId, hostileOnly) {
        const cover = new Set();
        const counts = other => other !== factionId && (!hostileOnly || this.isHostile(factionId, other));
        for (const army of this.armies) if (counts(army.faction)) for (const tile of this.zoneTiles(army.tile, army.zone)) cover.add(tile);
        for (const tower of this.construction.structures) if (tower.type === 'tower' && counts(tower.faction)) for (const tile of this.zoneTiles(tower.tile, this.options.fortressZone)) cover.add(tile);
        return cover;
    }

    /* ============================================================
       SECTION: MOVEMENT
       Очки движения и область достижимости.
       ============================================================ */

    // Сколько очков движения стоит войти в клетку (Infinity — не пройти).
    tileCost(tile) {
        const map = this.map, cost = this.options.moveCost;
        if (!map.isLand(tile)) return Infinity;
        if (map.river[tile] > 0 && !(map.crossing[tile] > 0)) return Infinity;
        if (map.roadLevel[tile] > 0 || map.crossing[tile] > 0) return cost.road;
        if (map.terrain[tile] === Terrain.MOUNTAIN) return cost.mountain;
        return this.economy.resource[tile] === Resource.WOOD ? cost.forest : cost.plain;
    }

    // Клетки, куда армия не войдёт: другие армии и вражеские башни.
    blockedTiles(army) {
        const blocked = new Set();
        for (const other of this.armies) if (other !== army) blocked.add(other.tile);
        for (const tower of this.construction.structures) if (tower.type === 'tower' && this.isHostile(army.faction, tower.faction)) blocked.add(tower.tile);
        return blocked;
    }

    /* Область достижимости: Map клетка -> { cost, prev } для всех клеток, куда армия дойдёт за оставшиеся очки движения (кроме своей).
       Вход в зону перехвата врага останавливает армию: клетка в зоне достижима, но дальше пути нет. */
    reachable(army) {
        const map = this.map, size = map.size;
        const hostileCover = this.zoneCover(army.faction, true);
        const blocked = this.blockedTiles(army);
        const best = new Map([[army.tile, { cost: 0, prev: -1 }]]);
        const queue = [[0, army.tile]];
        const done = new Set();
        while (queue.length > 0) {
            let at = 0;
            for (let k = 1; k < queue.length; k++) if (queue[k][0] < queue[at][0]) at = k;
            const [cost, tile] = queue.splice(at, 1)[0];
            if (done.has(tile)) continue;
            done.add(tile);
            if (tile !== army.tile && hostileCover.has(tile)) continue;
            const x = tile % size, y = (tile - x) / size;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                    const next = ny * size + nx;
                    const step = blocked.has(next) ? Infinity : this.tileCost(next);
                    if (!Number.isFinite(step)) continue;
                    const total = cost + step * (dx !== 0 && dy !== 0 ? this.options.diagonal : 1);
                    if (total > army.movesLeft + 1e-9) continue;
                    if (!best.has(next) || total < best.get(next).cost - 1e-9) {
                        best.set(next, { cost: total, prev: tile });
                        queue.push([total, next]);
                    }
                }
            }
        }
        best.delete(army.tile);
        return best;
    }

    // Путь до клетки по области достижимости: список клеток от первой после стоянки до цели ([] — не дойти).
    path(army, tile, reachable = this.reachable(army)) {
        const path = [];
        for (let at = tile; reachable.has(at); at = reachable.get(at).prev) path.unshift(at);
        return path;
    }

    /* ============================================================
       SECTION: ORDERS
       Найм, перемещение, атака, роспуск.
       ============================================================ */

    // Можно ли фракции нанять армию в клетке: { fits, ok, reason, cost }. fits — клетка подходит (своё поселение без армии), ok — и средств хватает.
    canRecruit(factionId, tile) {
        const cost = this.options.recruitCost;
        const no = reason => ({ fits: false, ok: false, reason, cost });
        const map = this.map;
        if (!(tile >= 0 && tile < map.terrain.length) || this.economy.resource[tile] !== Resource.SETTLEMENT) return no('Армию можно нанять только в поселении');
        if (map.tileFaction[tile] !== factionId) return no('Это не ваше поселение');
        if (this.armyAt(tile)) return no('В поселении уже стоит армия');
        const afford = this.economy.canAfford(factionId, cost);
        if (!afford.ok) return { fits: true, ok: false, reason: `Не хватает: ${this.construction.describeCost(afford.missing)}`, cost };
        return { fits: true, ok: true, reason: '', cost };
    }

    // Нанять армию (с оплатой). Новая армия стоит без очков движения до следующего хода.
    recruit(factionId, tile) {
        const check = this.canRecruit(factionId, tile);
        if (!check.ok) throw new Error(check.reason);
        this.economy.spend(factionId, check.cost);
        const army = this.create(factionId, tile, 0);
        this.emit({ action: 'recruit', armyId: army.id, factionId, tile });
        return army;
    }

    create(factionId, tile, movesLeft) {
        const a = this.options.army;
        const army = { id: this.nextId++, faction: factionId, tile, strength: a.strength, moves: a.moves, movesLeft, zone: a.zone };
        this.armies.push(army);
        return army;
    }

    // Переместить армию на клетку из области достижимости. После остановки захватывает территорию вокруг.
    move(armyId, tile) {
        const army = this.require(armyId);
        const reachable = this.reachable(army);
        if (!reachable.has(tile)) throw new Error('Армия не дойдёт до этой клетки');
        army.movesLeft = Math.max(0, army.movesLeft - reachable.get(tile).cost);
        if (this.zoneCover(army.faction, true).has(tile)) army.movesLeft = 0;       // вошла в зону перехвата врага: остановка
        army.tile = tile;
        const captured = this.occupy(army);
        this.emit({ action: 'move', armyId, factionId: army.faction, tile, captured });
    }

    /* Можно ли армии атаковать цель на клетке: враждебная армия или вражеская башня. Атакующий подходит к цели вплотную (stand) за очки
       движения. Возвращает { fits, ok, reason, kind: 'army' | 'fortress', stand, cost }. */
    canAttack(armyId, tile) {
        const army = this.get(armyId);
        const no = reason => ({ fits: false, ok: false, reason });
        if (!army) return no('Нет такой армии');
        const enemy = this.armyAt(tile), tower = this.towerAt(tile);
        const kind = enemy && this.isHostile(army.faction, enemy.faction) ? 'army' : tower && this.isHostile(army.faction, tower.faction) ? 'fortress' : null;
        if (!kind) return no('Здесь нет вражеской цели');
        if (army.movesLeft <= 0) return { fits: true, ok: false, reason: 'Нет очков движения', kind };

        const adjacent = this.zoneTiles(tile, 1);
        if (adjacent.includes(army.tile)) return { fits: true, ok: true, reason: '', kind, stand: army.tile, cost: 0 };
        const reachable = this.reachable(army);
        const stands = adjacent.filter(t => reachable.has(t)).sort((a, b) => reachable.get(a).cost - reachable.get(b).cost || a - b);
        if (stands.length === 0) return { fits: true, ok: false, reason: 'Цель вне досягаемости', kind };
        return { fits: true, ok: true, reason: '', kind, stand: stands[0], cost: reachable.get(stands[0]).cost };
    }

    // Атаковать цель на клетке. Атакующий остаётся на месте боя без очков движения; победа открывает захват клеток вокруг.
    attack(armyId, tile) {
        const check = this.canAttack(armyId, tile);
        if (!check.ok) throw new Error(check.reason);
        const army = this.get(armyId);
        if (check.stand !== army.tile) {
            const reachable = this.reachable(army);
            army.movesLeft = Math.max(0, army.movesLeft - reachable.get(check.stand).cost);
            army.tile = check.stand;
        }
        const result = check.kind === 'army' ? this.fightArmy(army, this.armyAt(tile)) : this.siegeTower(army, tile);
        army.movesLeft = 0;
        const survived = this.armies.includes(army);
        const captured = survived ? this.occupy(army) : 0;
        this.emit({ action: 'attack', armyId, factionId: army.faction, tile, kind: check.kind, ...result, captured });
        return result;
    }

    // Распустить армию (возврата нет).
    disband(armyId) {
        const army = this.require(armyId);
        this.armies = this.armies.filter(a => a !== army);
        this.emit({ action: 'disband', armyId, factionId: army.faction, tile: army.tile });
    }

    require(armyId) {
        const army = this.get(armyId);
        if (!army) throw new Error(`Нет армии ${armyId}`);
        return army;
    }

    /* ============================================================
       SECTION: COMBAT
       Бой армий и осада башен. Исход детерминирован: небольшой разброс берётся от хода и номеров армий (economyRandom).
       ============================================================ */

    // Бой атакующего с защитником: каждый выбивает долю силы другого (защитник — с множителем местности). Побеждённые (сила 0) исчезают.
    fightArmy(attacker, defender) {
        const c = this.options.combat;
        const luck = 1 + (economyRandom(this.turn, attacker.id * 131 + defender.id, 21) - 0.5) * 2 * c.spread;
        const defense = this.defenseAt(defender.tile);
        const defenderLoss = Math.min(defender.strength, Math.round(attacker.strength * c.casualty * luck));
        const attackerLoss = Math.min(attacker.strength, Math.round(defender.strength * defense * c.casualty * (2 - luck)));
        defender.strength -= defenderLoss;
        attacker.strength -= attackerLoss;
        const defenderDestroyed = defender.strength <= 0, attackerDestroyed = attacker.strength <= 0;
        this.armies = this.armies.filter(a => !(a === defender && defenderDestroyed) && !(a === attacker && attackerDestroyed));
        return { attackerLoss, defenderLoss, attackerDestroyed, defenderDestroyed };
    }

    // Множитель защиты на клетке: горы и лес помогают обороняющемуся.
    defenseAt(tile) {
        const d = this.options.combat.defense;
        if (this.map.terrain[tile] === Terrain.MOUNTAIN) return d.mountain;
        return this.economy.resource[tile] === Resource.WOOD ? d.forest : 1;
    }

    // Осада башни: армия наносит урон башне и сама получает ответный урон; при нуле прочности башня разрушается.
    siegeTower(army, tile) {
        const c = this.options.combat;
        const luck = 1 + (economyRandom(this.turn, army.id * 131 + tile, 22) - 0.5) * 2 * c.spread;
        const damage = Math.round(army.strength * c.fortressAttack * luck);
        const outcome = this.construction.damageTower(tile, damage);
        const attackerLoss = Math.min(army.strength, c.fortressDamage);
        army.strength -= attackerLoss;
        const attackerDestroyed = army.strength <= 0;
        if (attackerDestroyed) this.armies = this.armies.filter(a => a !== army);
        return { attackerLoss, defenderLoss: damage, attackerDestroyed, defenderDestroyed: outcome.destroyed, towerHp: outcome.hp };
    }

    /* ============================================================
       SECTION: OCCUPATION
       Оккупация и захват территорий.
       ============================================================ */

    /* Клетки, которые армия захватит сейчас: только та, на которой она стоит. Клетка должна быть сушей, ещё не нашей,
       ничьей или враждебной (не мирной и не союзной) и не лежать в зоне перехвата армии или башни другой фракции. */
    capturable(army) {
        const map = this.map, f = army.faction;
        const cover = this.zoneCover(f, false);
        const tile = army.tile;
        const owner = map.tileFaction[tile];
        if (!map.isLand(tile) || owner === f || cover.has(tile)) return [];
        if (owner !== -1 && !this.isHostile(f, owner)) return [];
        return [tile];
    }

    // Захватить клетки (capturable) для фракции армии. Возвращает, сколько клеток захвачено.
    occupy(army) {
        const tiles = this.capturable(army);
        if (tiles.length === 0) return 0;
        if (this.factions) return this.factions.claimTiles(army.faction, tiles);
        for (const tile of tiles) this.map.tileFaction[tile] = army.faction;
        return tiles.length;
    }

    /* ============================================================
       SECTION: PREVIEW
       Что показать игроку при выборе армии.
       ============================================================ */

    /* Подсветка выбранной армии: reachable — куда можно дойти, zone — девять клеток захвата, targets — вражеские армии и башни, которые можно
       атаковать, tile — клетка армии. */
    preview(army) {
        const reachable = [...this.reachable(army).keys()];
        const zone = this.zoneTiles(army.tile, army.zone).filter(tile => this.map.isLand(tile));
        const targets = [
            ...this.armies.filter(a => this.isHostile(army.faction, a.faction)).map(a => a.tile),
            ...this.construction.structures.filter(s => s.type === 'tower' && this.isHostile(army.faction, s.faction)).map(s => s.tile)
        ].filter(tile => this.canAttack(army.id, tile).ok);
        return { tile: army.tile, reachable, zone, targets };
    }

    /* ============================================================
       SECTION: TURN
       Фаза хода и стартовые армии.
       ============================================================ */

    /* Фаза хода (turns.addPhase('armies', context => armies.step(context))): армии получают очки движения, на своей земле лечатся,
       затем каждая (по порядку номеров) захватывает территорию вокруг. */
    step(turn = {}) {
        this.turn = turn.turn ?? this.turn + 1;
        const heal = this.options.army.heal, max = this.options.army.strength;
        for (const army of this.armies) {
            army.movesLeft = army.moves;
            if (this.map.tileFaction[army.tile] === army.faction) army.strength = Math.min(max, army.strength + heal);
        }
        let captured = 0;
        for (const army of [...this.armies]) captured += this.occupy(army);
        this.emit({ action: 'turn', armyId: -1, captured });
    }

    // Стартовые армии: options.start.army штук у каждой фракции, в её поселениях, ближайших к столице (без оплаты, сразу готовы к ходу).
    seed() {
        const map = this.map, size = map.size;
        for (const faction of map.factions) {
            const anchor = faction.capitalTile >= 0 ? faction.capitalTile : map.tileFaction.indexOf(faction.id);
            if (anchor < 0) continue;
            const ax = anchor % size, ay = Math.floor(anchor / size);
            const towns = [];
            for (let i = 0; i < map.tileFaction.length; i++) {
                if (map.tileFaction[i] === faction.id && this.economy.resource[i] === Resource.SETTLEMENT && !this.armyAt(i)) towns.push({ i, d: Math.hypot(i % size - ax, Math.floor(i / size) - ay) });
            }
            towns.sort((a, b) => a.d - b.d || a.i - b.i);
            for (let k = 0; k < this.options.start.army && k < towns.length; k++) this.create(faction.id, towns[k].i, this.options.army.moves);
        }
        this.emit({ action: 'seed', armyId: -1 });
    }

    /* ============================================================
       SECTION: SAVE
       Сохранение.
       ============================================================ */

    getState() {
        return { armies: this.armies.map(a => ({ ...a })), nextId: this.nextId, turn: this.turn };
    }

    setState(state) {
        this.armies = state.armies.map(a => ({ ...a }));
        this.nextId = state.nextId;
        this.turn = state.turn;
        this.emit({ action: 'load', armyId: -1 });
    }
}