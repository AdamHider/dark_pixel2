/* ============================================================
   SECTION: FACTION_MANAGER
   FactionManager — фракции, их территории, ресурсы и доход.

   Это отдельный от карты модуль. Он единственный владелец состояния фракций (кто чем владеет) и всех правил:
   расстановка стартовых фракций, захват и освобождение клеток и регионов, сводки по ресурсам, сохранение. Карта (MapGenerator)
   фракциями не управляет: менеджер читает из неё данные (регионы, ресурсы, население) и передаёт обратно готовое состояние
   (map.applyFactionState). Карта хранит его, показывает в getTileInfo / getRegionInfo и отдаёт отрисовке (MapRenderer),
   а рендерер перерисовывает слой фракций сам, когда состояние в карте меняется.

   Подключать после map-generator.js: из него берутся константы Resource, ResourceInfo и Terrain.

   Использование:
     const map = new MapGenerator(options).generate(seed);
     const factions = new FactionManager(map);      // фракции пока пустые
     factions.generate();                           // стартовые фракции (по умолчанию красные и синие по 4–5 регионов)
     renderer.refresh();

     factions.claimTiles(0, [1520, 1521]);          // дальше управляем только через менеджер — карта обновится сама
     factions.claimRegion(1, 17);
     factions.getFactionInfo(0);                    // территория, население, ресурсы, доход
     const off = factions.onChange(() => ...);      // подписка на любые изменения

   После новой генерации карты вызовите factions.attach(map) (или factions.generate()): состояние старой карты ей не подходит.
   ============================================================ */

// Небольшой детерминированный генератор случайных чисел (mulberry32): расстановка фракций не зависит ни от порядка вызовов, ни от
// состояния генератора карты — для одной карты и одних настроек результат всегда один и тот же.
function factionRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Оформление фракции: основной цвет (территория), второй цвет и флаг. Флаг — узор поля (цвета: основной и второй) и эмблема.
const FACTION_FLAG_PATTERNS = ['pale', 'fess', 'bend', 'cross', 'saltire', 'chevron', 'stripes', 'solid'];
const FACTION_FLAG_EMBLEMS = ['star', 'circle', 'diamond', 'tower', 'cross', 'none'];

// Цвет «#rgb» или «#rrggbb» -> [r, g, b]; null, если это не цвет.
function parseHexColor(hex) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
    if (!match) return null;
    const text = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
    return [0, 2, 4].map(i => parseInt(text.slice(i, i + 2), 16));
}

// Второй цвет по умолчанию: к светлому основному — тёмный, к тёмному — светлый (чтобы узор флага читался).
function contrastColor(hex) {
    const rgb = parseHexColor(hex) || [153, 153, 153];
    const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.55;
    const mixed = rgb.map(v => Math.round(light ? v * 0.4 : v + (255 - v) * 0.7));
    return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('');
}

class FactionManager {
    static get DEFAULTS() {
        return {
            // Стартовые фракции. regions — сколько регионов: число или [мин, макс].
            factions: [
                { name: 'Красные', color: '#d94a3a', secondaryColor: '#f2d27a', flag: { pattern: 'pale', emblem: 'star' }, regions: [4, 5] },
                { name: 'Синие', color: '#3b6fd4', secondaryColor: '#e8ecf4', flag: { pattern: 'chevron', emblem: 'tower' }, regions: [4, 5] },
                { name: 'Желтые', color: '#FFDB58', secondaryColor: '#7a4a1c', flag: { pattern: 'fess', emblem: 'circle' }, regions: [4, 5] },
                { name: 'Розовые', color: '#FFB6C1', secondaryColor: '#8c2f58', flag: { pattern: 'bend', emblem: 'diamond' }, regions: [4, 5] },
                { name: 'Зелёные', color: '#808000', secondaryColor: '#e6e0a8', flag: { pattern: 'saltire', emblem: 'cross' }, regions: [4, 5] }
            ],
            playerFaction: 0,  // какая из стартовых фракций (по номеру) — фракция игрока; null или -1 — никто
            seedDistance: 5,   // на каком расстоянии (в регионах) друг от друга стоят столицы
            attempts: 160,     // сколько раскладок перебрать при расстановке; берётся лучшая по ресурсам и равенству сторон
            coverageWeight: 20, // вес разнообразия ресурсов (дерево, поля, металл, эфир) при выборе раскладки
            fairnessWeight: 80, // вес равенства населения сторон
            seed: null         // зерно случайных чисел расстановки (null — брать из зерна карты)
        };
    }

    constructor(map, options = {}) {
        this.options = { ...FactionManager.DEFAULTS, ...options };
        this.listeners = new Set();
        this.version = 0;
        this.attach(map);
    }

    /* ============================================================
       SECTION: STATE
       ============================================================ */

    // Привязать менеджер к карте (в том числе к заново сгенерированной): состояние сбрасывается и передаётся в карту.
    attach(map) {
        this.map = map;
        this.factions = [];                                              // { id, name, color, secondaryColor, flag: { pattern, emblem }, capitalRegion, capitalTile, player }
        this.tileFaction = new Int16Array(map.size * map.size).fill(-1); // id фракции-владельца клетки, -1 — ничья
        this.touch('attach');
    }

    // Состояние изменилось: увеличиваем версию, передаём состояние в карту и оповещаем подписчиков.
    touch(reason) {
        this.version++;
        if (typeof this.map.applyFactionState === 'function') {
            this.map.applyFactionState({ factions: this.factions, tileFaction: this.tileFaction, version: this.version });
        }
        for (const listener of [...this.listeners]) listener(this, reason);
    }

    // Подписка на любые изменения: listener(менеджер, причина). Возвращает функцию отписки.
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // Состояние для сохранения (обычный объект, годится для JSON).
    getState() {
        const owners = {};
        for (let i = 0; i < this.tileFaction.length; i++) {
            const faction = this.tileFaction[i];
            if (faction >= 0) (owners[faction] ||= []).push(i);
        }
        return { format: 1, mapSeed: this.map.seed, factions: this.factions.map(f => ({ ...f })), owners };
    }

    // Восстановить сохранённое состояние (для той же карты).
    setState(state) {
        if (!state || state.format !== 1) throw new Error('Неизвестный формат состояния фракций');
        if (state.mapSeed !== this.map.seed) throw new Error('Состояние сохранено для другой карты');
        this.factions = state.factions.map(f => ({ ...f }));
        this.options.playerFaction = this.playerFaction ? this.playerFaction.id : -1;
        this.tileFaction.fill(-1);
        for (const [faction, tiles] of Object.entries(state.owners)) for (const tile of tiles) this.tileFaction[tile] = Number(faction);
        this.touch('state');
    }

    /* ============================================================
       SECTION: CONTROL
       ============================================================ */

    // Новая фракция из описания { name, color, secondaryColor, flag: { pattern, emblem } }: чего нет — подбирается само.
    static makeFaction(definition, id, player = false) {
        const color = parseHexColor(definition.color) ? definition.color : '#999999';
        const flag = definition.flag || {};
        return {
            id, name: definition.name || `Фракция ${id + 1}`, color,
            secondaryColor: parseHexColor(definition.secondaryColor) ? definition.secondaryColor : contrastColor(color),
            flag: { pattern: flag.pattern || FACTION_FLAG_PATTERNS[id % FACTION_FLAG_PATTERNS.length], emblem: flag.emblem || FACTION_FLAG_EMBLEMS[(id * 2 + 1) % FACTION_FLAG_EMBLEMS.length] },
            capitalRegion: -1, capitalTile: -1, player
        };
    }

    addFaction(definition = {}) {
        const id = this.factions.length;
        this.factions.push(FactionManager.makeFaction(definition, id));
        this.touch('add');
        return id;
    }

    // Сменить оформление фракции: любое из color, secondaryColor, flag (flag сливается с прежним).
    setFactionStyle(factionId, { color, secondaryColor, flag } = {}) {
        const faction = this.factions[factionId];
        if (!faction) throw new Error(`Нет фракции ${factionId}`);
        if (parseHexColor(color)) faction.color = color;
        if (parseHexColor(secondaryColor)) faction.secondaryColor = secondaryColor;
        if (flag) faction.flag = { ...faction.flag, ...flag };
        this.touch('style');
    }

    // Отдаёт клетки фракции (id = -1 — освободить). Клетка — индекс; владеть можно только сушей. Возвращает, сколько клеток изменилось.
    claimTiles(factionId, tiles) {
        if (factionId !== -1 && !this.factions[factionId]) throw new Error(`Нет фракции ${factionId}`);
        const changed = this.assignTiles(factionId, tiles);
        if (changed > 0) this.touch('claim');
        return changed;
    }

    releaseTiles(tiles) {
        return this.claimTiles(-1, tiles);
    }

    claimRegion(factionId, regionId) {
        return this.claimTiles(factionId, this.map.regionTileList(regionId));
    }

    releaseRegion(regionId) {
        return this.claimRegion(-1, regionId);
    }

    // Фракция игрока (одна; -1 — никто). Флаг лежит на самой фракции, поэтому доходит до карты (map.factions) и попадает в сохранение.
    setPlayerFaction(factionId) {
        if (factionId !== -1 && !this.factions[factionId]) throw new Error(`Нет фракции ${factionId}`);
        this.options.playerFaction = factionId;   // запоминаем: следующая generate() оставит игроком ту же фракцию
        for (const faction of this.factions) faction.player = faction.id === factionId;
        this.touch('player');
    }

    // То же без оповещения (для пакетных изменений внутри менеджера).
    assignTiles(factionId, tiles) {
        let changed = 0;
        for (const tile of tiles) {
            if (!this.map.isLand(tile) || this.tileFaction[tile] === factionId) continue;
            this.tileFaction[tile] = factionId;
            changed++;
        }
        return changed;
    }

    /* ============================================================
       SECTION: READ
       ============================================================ */

    factionAt(tile) {
        return this.tileFaction[tile];
    }

    get playerFaction() {
        return this.factions.find(f => f.player) || null;
    }

    getPlayerInfo() {
        const faction = this.playerFaction;
        return faction ? this.getFactionInfo(faction.id) : null;
    }

    getFactionTiles(factionId) {
        const tiles = [];
        for (let i = 0; i < this.tileFaction.length; i++) if (this.tileFaction[i] === factionId) tiles.push(i);
        return tiles;
    }

    // Регионы, где у фракции есть клетки: { id, owned (клеток фракции), total (всего), full (весь регион её) }.
    getFactionRegions(factionId) {
        const { regionId, regionSizes } = this.map;
        const owned = {};
        for (let i = 0; i < this.tileFaction.length; i++) {
            if (this.tileFaction[i] !== factionId) continue;
            const region = regionId[i];
            if (region >= 0) owned[region] = (owned[region] || 0) + 1;
        }
        return Object.keys(owned).map(Number).map(id => ({ id, owned: owned[id], total: regionSizes[id], full: owned[id] === regionSizes[id] }));
    }

    /* Сводка по фракции: территория, население, поселения, ресурсы и доход.
       income — сумма того, что дают клетки (ResourceInfo): food, production, gold, ether, population;
       у клеток с поселением население берётся из map.population. */
    getFactionInfo(factionId) {
        const faction = this.factions[factionId];
        if (!faction) return null;
        const map = this.map;
        const tiles = this.getFactionTiles(factionId);
        const info = {
            id: faction.id, name: faction.name, color: faction.color, secondaryColor: faction.secondaryColor, flag: faction.flag, player: !!faction.player,
            capitalRegion: faction.capitalRegion, capitalTile: faction.capitalTile,
            tiles, size: tiles.length,
            regions: this.getFactionRegions(factionId),
            population: 0,
            settlements: [],
            resources: [0, 0, 0, 0, 0, 0, 0],   // по кодам Resource (0 — клетки без ресурса)
            biomes: [0, 0, 0, 0, 0, 0],         // по кодам Biome (без гор)
            mountains: 0,
            coastal: false,
            income: { food: 0, production: 0, gold: 0, ether: 0, population: 0 }
        };
        const owned = new Set(tiles);
        info.settlements = map.settlements.filter(s => owned.has(s.tile));
        for (const i of tiles) {
            if (map.terrain[i] === Terrain.MOUNTAIN) info.mountains++;
            else info.biomes[map.biome[i]]++;
            const resource = map.resource[i];
            info.resources[resource]++;
            info.population += map.population[i];
            const produces = ResourceInfo[resource] ? ResourceInfo[resource].produces : null;
            if (produces) {
                for (const [kind, amount] of Object.entries(produces)) {
                    if (resource === Resource.SETTLEMENT && kind === 'population') info.income.population += map.population[i];
                    else info.income[kind] = (info.income[kind] || 0) + amount;
                }
            }
            if (!info.coastal && map.neighbors(i).some(j => !map.isLand(j))) info.coastal = true;
        }
        return info;
    }

    /* Территории в формате, который понимает слой фракций (painter.paintTerritories / renderer.setTerritories):
       [{ id, color, tiles }]. Обычно не нужны — карта показывает состояние, которое менеджер сам в неё передал, —
       но пригодятся, если хочется дополнить или заменить показ своими территориями. */
    territories() {
        const tiles = this.factions.map(() => []);
        for (let i = 0; i < this.tileFaction.length; i++) {
            const owner = this.tileFaction[i];
            if (owner >= 0 && tiles[owner]) tiles[owner].push(i);
        }
        return this.factions.map(f => ({ id: f.id, color: f.color, tiles: tiles[f.id] }));
    }

    /* ============================================================
       SECTION: START_FACTIONS
       ============================================================ */

    // Сколько регионов у фракции: число или [мин, макс] (случайно, включительно).
    regionCount(value, random) {
        if (Array.isArray(value)) return value[0] + Math.floor(random() * (value[1] - value[0] + 1));
        return Math.max(1, value || 4);
    }

    /* Расставляет стартовые фракции (прежние сбрасываются): столицы на расстоянии seedDistance регионов друг от друга,
       вокруг каждой — компактная группа соседних регионов нужного размера. Регионы растут по очереди, чтобы никого не зажали.
       Из attempts раскладок берётся лучшая: сначала набранный размер, потом разнообразие ресурсов (дерево, поля, металл, эфир)
       и примерно равное население сторон. */
    generate(definitions = this.options.factions) {
        const map = this.map;
        const random = factionRandom(this.options.seed ?? ((map.seed | 0) ^ 0x9e3779b9));

        this.factions = [];
        this.tileFaction.fill(-1);
        const defs = definitions || [];
        for (const def of defs) this.factions.push(FactionManager.makeFaction(def, this.factions.length, this.factions.length === this.options.playerFaction));
        if (defs.length === 0) {
            this.touch('generate');
            return this;
        }

        const graph = map.regionGraph();
        const tilesByRegion = {};
        for (const i of map.landTiles) {
            const id = map.regionId[i];
            if (id >= 0) (tilesByRegion[id] ||= []).push(i);
        }
        const center = {}, usable = new Set();
        for (const id of graph.keys()) {
            const tiles = tilesByRegion[id] || [];
            let cx = 0, cy = 0, mountains = 0;
            for (const i of tiles) {
                cx += i % map.size;
                cy += Math.floor(i / map.size);
                if (map.terrain[i] === Terrain.MOUNTAIN) mountains++;
            }
            center[id] = [cx / Math.max(1, tiles.length), cy / Math.max(1, tiles.length)];
            // мелкие обрывки и сплошные горы столицей и частью стартовой фракции не делаем
            if (tiles.length >= map.options.regionMinSize * 0.6 && mountains / tiles.length < 0.6) usable.add(id);
        }
        const links = id => [...graph.get(id)].filter(n => usable.has(n));
        const score = id => (map.regionPopulation[id] || 0);

        // Что есть в каждом регионе: по этому выбираем раскладку, где у обеих фракций есть дерево, поля, металл и примерно поровну людей.
        const stats = {};
        for (const id of usable) {
            const s = { wood: 0, wheat: 0, metal: 0, ether: 0, population: map.regionPopulation[id] || 0 };
            for (const i of tilesByRegion[id]) {
                const r = map.resource[i];
                if (r === Resource.WOOD) s.wood++;
                else if (r === Resource.WHEAT) s.wheat++;
                else if (r === Resource.GOLD || r === Resource.IRON) s.metal++;
                else if (r === Resource.ETHER) s.ether++;
            }
            stats[id] = s;
        }
        const quality = owned => {
            const totals = owned.map(list => list.reduce((sum, id) => ({
                wood: sum.wood + stats[id].wood, wheat: sum.wheat + stats[id].wheat, metal: sum.metal + stats[id].metal,
                ether: sum.ether + stats[id].ether, population: sum.population + stats[id].population
            }), { wood: 0, wheat: 0, metal: 0, ether: 0, population: 0 }));
            let coverage = 0;
            for (const s of totals) coverage += (s.wood >= 4) + (s.wheat >= 4) + (s.metal >= 1) + 0.5 * (s.ether >= 1);
            const populations = totals.map(s => s.population);
            const fairness = Math.min(...populations) / Math.max(1, Math.max(...populations));
            return coverage * this.options.coverageWeight + fairness * this.options.fairnessWeight;
        };

        // связные группы пригодных регионов; берём ту, где хватит места всем
        const wanted = defs.map(def => this.regionCount(def.regions, random));
        const need = wanted.reduce((a, b) => a + b, 0);
        const components = [];
        const seen = new Set();
        for (const id of usable) {
            if (seen.has(id)) continue;
            const group = [id];
            seen.add(id);
            for (let head = 0; head < group.length; head++) for (const n of links(group[head])) if (!seen.has(n)) { seen.add(n); group.push(n); }
            components.push(group);
        }
        components.sort((a, b) => b.length - a.length);
        const pool = (components.find(c => c.length >= need * 1.3) || components[0] || []).slice();
        if (pool.length === 0) {
            this.touch('generate');
            return this;
        }
        const inPool = new Set(pool);

        // расстояние в регионах от набора регионов (поиск в ширину)
        const hopsFrom = sources => {
            const hops = new Map(sources.map(s => [s, 0]));
            const queue = sources.slice();
            for (let head = 0; head < queue.length; head++) {
                for (const n of links(queue[head])) if (inPool.has(n) && !hops.has(n)) { hops.set(n, hops.get(queue[head]) + 1); queue.push(n); }
            }
            return hops;
        };

        let best = null;
        for (let attempt = 0; attempt < this.options.attempts; attempt++) {
            // столицы: первая — среди самых населённых, остальные — примерно на нужном расстоянии от уже выбранных
            const top = pool.slice().sort((a, b) => score(b) - score(a)).slice(0, Math.max(3, Math.ceil(pool.length * 0.15)));
            const seeds = [top[Math.floor(random() * top.length)]];
            while (seeds.length < defs.length) {
                const hops = hopsFrom(seeds);
                const choices = pool.filter(id => !seeds.includes(id) && hops.has(id));
                if (choices.length === 0) break;
                const goal = this.options.seedDistance;
                const fitness = id => -Math.abs(hops.get(id) - goal) * 10 + Math.min(score(id), 400) / 100 + random() * 3;
                choices.sort((a, b) => fitness(b) - fitness(a));
                seeds.push(choices[0]);
            }
            if (seeds.length < defs.length) continue;

            // рост по очереди: берём свободного соседа, ближайшего к центру тяжести фракции
            const owned = defs.map((_, k) => [seeds[k]]);
            const claimed = new Map(seeds.map((id, k) => [id, k]));
            let progress = true;
            while (progress) {
                progress = false;
                for (let k = 0; k < defs.length; k++) {
                    if (owned[k].length >= wanted[k]) continue;
                    const cx = owned[k].reduce((s, id) => s + center[id][0], 0) / owned[k].length;
                    const cy = owned[k].reduce((s, id) => s + center[id][1], 0) / owned[k].length;
                    let pick = -1, pickDistance = Infinity;
                    for (const id of owned[k]) {
                        for (const n of links(id)) {
                            if (claimed.has(n) || !inPool.has(n)) continue;
                            const distance = Math.hypot(center[n][0] - cx, center[n][1] - cy) + random() * 1.5;
                            if (distance < pickDistance) { pickDistance = distance; pick = n; }
                        }
                    }
                    if (pick === -1) continue;
                    owned[k].push(pick);
                    claimed.set(pick, k);
                    progress = true;
                }
            }
            // главное — чтобы набрался нужный размер, потом — разнообразие ресурсов и равенство сторон
            const filled = owned.reduce((s, list, k) => s + Math.min(list.length, wanted[k]), 0);
            const fitness = filled * 1000 + quality(owned);
            if (!best || fitness > best.fitness) best = { owned, filled, fitness };
        }

        if (best) {
            best.owned.forEach((regions, k) => {
                const faction = this.factions[k];
                faction.capitalRegion = regions[0];
                for (const id of regions) this.assignTiles(k, map.regionTileList(id));
                faction.capitalTile = this.capitalTileOf(regions[0], tilesByRegion[regions[0]] || []);
            });
        }
        this.touch('generate');
        return this;
    }

    // Столица региона: центр самой населённой группы поселений, а без поселений — клетка равнины ближе всего к середине региона.
    capitalTileOf(regionId, tiles) {
        const map = this.map;
        const groups = map.settlementGroups.filter(g => g.regionId === regionId).sort((a, b) => b.population - a.population);
        if (groups.length > 0) return groups[0].tile;
        let cx = 0, cy = 0;
        for (const i of tiles) { cx += i % map.size; cy += Math.floor(i / map.size); }
        cx /= Math.max(1, tiles.length);
        cy /= Math.max(1, tiles.length);
        let best = tiles[0] ?? -1, bestDistance = Infinity;
        for (const i of tiles) {
            if (map.terrain[i] !== Terrain.PLAIN || map.river[i]) continue;
            const distance = Math.hypot((i % map.size) - cx, Math.floor(i / map.size) - cy);
            if (distance < bestDistance) { bestDistance = distance; best = i; }
        }
        return best;
    }
}