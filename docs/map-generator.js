/* ============================================================
   Слои данных клетки. Карта хранится в плоских массивах: клетка (x, y) — это индекс y * size + x.
   [тип массива, значение по умолчанию]. Всё, что не перечислено здесь, — объекты в resetState().
   ============================================================ */
MapGen.TILE_LAYERS = {
    elevation: [Float32Array],
    moisture: [Float32Array],
    ridge: [Float32Array],                 // 0..1: насколько клетка похожа на горный хребет
    massif: [Float32Array],                // 0..1: крупные «пятна» для горных массивов
    temperature: [Float32Array],
    terrain: [Uint8Array],                 // Terrain
    mountainHeight: [Float32Array],        // 0 вне гор; 0.3..1 в горах — по нему рисуется рельеф
    waterDepth: [Uint8Array],              // 0 на суше; в воде — расстояние до ближайшей суши
    biome: [Uint8Array],                   // Biome
    resource: [Uint8Array],                // Resource
    shore: [Uint8Array],                   // тип берега (Shore) у суши рядом с водой и реками
    river: [Uint8Array],                   // 0 — реки нет, 1..3 — её глубина
    riverTo: [Int32Array, -1],             // куда течёт река из этой клетки (-1 — не река или сток за краем карты)
    riverFlow: [Uint16Array],              // сколько воды проходит через клетку (определяет ширину реки)
    crossing: [Uint8Array],                // 0 — нет, 1 — брод, 2 — каменный мост
    regionId: [Int16Array, -1],            // -1 — клетка вне региона (вода и реки)
    population: [Uint16Array],             // население в клетке с поселением
    settlementLevel: [Uint8Array],         // уровень клетки с поселением 1..4 (0 — нет поселения)
    settlementGroup: [Int16Array, -1],     // номер группы поселений в клетке, -1 — нет
    roadLevel: [Uint8Array],               // 0 — нет дороги, 1..3 — насколько она наезжена
    roadLinks: [Uint8Array],               // биты: в какие из 8 сторон (DIRECTIONS_8) идёт дорога из клетки
    growth: [Float32Array],                // степень роста клетки 0..1: леса и поля (у остальных клеток 0)
    tileFaction: [Int16Array, -1]          // кому принадлежит клетка (id фракции), -1 — никому
};

// Слои шума: seed + порядковый номер (с 1). Порядок менять нельзя — от него зависят все существующие карты.
MapGen.NOISE_LAYERS = ['elevation', 'ridge', 'temperature', 'moisture', 'warpX', 'warpY', 'forest', 'fertility', 'shape', 'basin',
    'regionShape', 'islands', 'massif', 'forestClumps', 'fertilityClumps', 'ore', 'fault', 'shore', 'iron'];

// Шаги генерации по порядку. Каждый — метод MapGenerator (см. миксины ниже).
// Этапы генерации по порядку. Каждый — подсистема MapGen.<Имя> с единым входом build(map); её настройки (defaults) собираются
// в MapGenerator.DEFAULTS. Порядок важен: от него зависят и результат, и последовательность случайных чисел (а значит, все карты).
MapGen.PIPELINE = ['Relief', 'Drainage', 'Climate', 'Flora', 'Rivers', 'Shores', 'Deposits', 'Crossings', 'Regions', 'Settlements', 'Roads', 'Growth'];

/* Простой «канал»: подписчики получают каждое новое состояние. Подписка возвращает функцию отписки. */
MapGen.Emitter = class Emitter {
    constructor() {
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(payload) {
        for (const listener of [...this.listeners]) listener(payload);
    }
};

/* ============================================================
   MapGenerator — ядро
   ============================================================ */
class MapGenerator {
    // Настройки лежат рядом с кодом своей подсистемы (MapGen.<Имя>.defaults); здесь собираются в один плоский объект.
    static get DEFAULTS() {
        const options = {
            size: 150,                // сторона карты в клетках (значения «по размеру карты» заданы для 300 и пересчитываются)
            seed: 1
        };
        for (const name of MapGen.PIPELINE) Object.assign(options, MapGen[name].defaults);
        return JSON.parse(JSON.stringify(options));       // свежая копия: массивы (riverThresholds) не должны делиться между картами
    }

    constructor(options = {}) {
        this.options = { ...MapGenerator.DEFAULTS, ...options };
        this.size = this.options.size;
        this.cache4 = new Array(this.size * this.size);   // соседи клеток, считаются по требованию
        this.cache8 = new Array(this.size * this.size);
        // Подписчики переживают новую генерацию.
        this.turnChannel = new MapGen.Emitter();                 // состояние хода (onTurnState)
        this.economyChannel = new MapGen.Emitter();              // состояние экономики (onEconomyState)
        this.factionChannel = new MapGen.Emitter();              // состояние фракций (onFactionState)
    }

    // Конвейер генерации: один seed — одна карта.
    generate(seed = this.options.seed) {
        this.seed = seed;
        this.random = createRandom(seed);
        this.noise = Object.fromEntries(MapGen.NOISE_LAYERS.map((name, k) => [name, new ValueNoise(seed + k + 1)]));
        this.allocateLayers();
        for (const name of MapGen.PIPELINE) MapGen[name].build(this);
        return this;
    }

    allocateLayers() {
        const count = this.size * this.size;
        for (const [name, [Type, fill]] of Object.entries(MapGen.TILE_LAYERS)) {
            this[name] = new Type(count);
            if (fill !== undefined) this[name].fill(fill);
        }
        this.resetState();
    }

    // Всё, что не лежит по клеткам.
    resetState() {
        this.landTiles = [];                          // индексы всех клеток суши
        this.settlements = [];                        // по записи на каждую клетку с поселением: { id, groupId, regionId, tile, population, level, center }
        this.settlementGroups = [];                   // группы соседних клеток: { id, regionId, tiles, tile (центр), population }
        this.regionPopulation = {};                   // id региона -> население
        this.regionSizes = {};                        // id региона -> число клеток
        // Ход, экономика и фракции — только данные: их передают менеджеры (applyTurnState, applyEconomyState, applyFactionState).
        this.turnState = { turn: 0, year: 0, season: null, seasonIndex: 0, turnInSeason: 0, version: 0 };
        this.economyVersion = 0;                      // версия состояния экономики
        this.visualVersion = 0;                       // растёт, только когда экономика изменила то, что видно (ступень роста, уровень поселения)
        this.factions = [];                           // фракции: { id, name, color, capitalRegion, capitalTile }
        this.factionVersion = 0;                      // версия состояния от менеджера: по ней перерисовывается слой фракций
    }

    /* ---------- Сетка: координаты, соседи, обходы ---------- */

    index(x, y) {
        return y * this.size + x;
    }

    isLand(i) {
        return this.terrain[i] >= Terrain.PLAIN;
    }

    neighborList(i, directions) {
        const size = this.size, x = i % size, y = (i - x) / size;
        const result = [];
        for (const [dx, dy] of directions) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < size && ny < size) result.push(ny * size + nx);
        }
        return result;
    }

    // Четыре соседа (влево, вправо, вверх, вниз) внутри карты. Список общий для всех вызовов — не изменяйте его.
    neighbors(i) {
        return this.cache4[i] ??= this.neighborList(i, MapGen.DIRECTIONS_4);
    }

    // Восемь соседей, включая диагональных. Список общий — не изменяйте его.
    neighbors8(i) {
        return this.cache8[i] ??= this.neighborList(i, MapGen.DIRECTIONS_8);
    }

    // Смещение (dx, dy) от клетки from к клетке to.
    delta(from, to) {
        const size = this.size;
        return [(to % size) - (from % size), Math.floor(to / size) - Math.floor(from / size)];
    }

    isDiagonal(a, b) {
        const [dx, dy] = this.delta(a, b);
        return dx !== 0 && dy !== 0;
    }

    // fn(клетка, nx, ny) для каждой клетки; nx, ny — координаты 0..1.
    eachTile(fn) {
        const size = this.size;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) fn(y * size + x, x / size, y / size);
        }
    }

    // fn(клетка) для квадрата радиуса radius вокруг клетки i (включая её саму).
    eachInSquare(i, radius, fn) {
        const size = this.size, x = i % size, y = Math.floor(i / size);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < size && ny < size) fn(ny * size + nx);
            }
        }
    }

    markSquare(flags, i, radius) {
        this.eachInSquare(i, radius, j => { flags[j] = 1; });
    }

    // Слой шума по всей карте: значение в клетке — noise.fractal(nx * scale, ny * scale, octaves), при желании пропущенное через transform.
    noiseLayer(noise, scale, octaves = 3, transform = v => v) {
        const layer = new Float32Array(this.size * this.size);
        this.eachTile((i, nx, ny) => { layer[i] = transform(noise.fractal(nx * scale, ny * scale, octaves)); });
        return layer;
    }

    // Слой «плотности»: плавный шум, выровненный до равномерных значений 0..1 (порог 1 - share отбирает долю share карты).
    densityLayer(noise, scale, octaves = 3, transform) {
        return rankNormalize(this.noiseLayer(noise, scale, octaves, transform));
    }

    // Связные куски клеток (соседи по сторонам); клетки одного куска связывает same(кандидат, старт). Старты — по порядку (по умолчанию все клетки).
    // Обход в ширину; порядок добавления в очередь сохраняется, поэтому результат детерминирован.
    // Это генератор: куски отдаются по одному, и карту можно менять между ними.
    * components(same, starts = null) {
        const visited = new Uint8Array(this.size * this.size);
        const total = starts ? starts.length : visited.length;
        for (let k = 0; k < total; k++) {
            const start = starts ? starts[k] : k;
            if (visited[start] || !same(start, start)) continue;
            const queue = [start];
            visited[start] = 1;
            for (let head = 0; head < queue.length; head++) {
                for (const neighbor of this.neighbors(queue[head])) {
                    if (visited[neighbor] || !same(neighbor, start)) continue;
                    visited[neighbor] = 1;
                    queue.push(neighbor);
                }
            }
            yield queue;
        }
    }

    // Расстояние (в шагах волны) от ближайшего из sources; -1 — не дошли. accept(клетка) — можно ли в неё войти.
    // diagonal — идти ли ещё и по диагоналям; maxDistance — дальше не расходимся.
    distanceFrom(sources, { accept = () => true, diagonal = false, maxDistance = Infinity } = {}) {
        const distance = new Int16Array(this.size * this.size).fill(-1);
        const queue = Array.from(sources);
        for (const source of queue) distance[source] = 0;
        for (let head = 0; head < queue.length; head++) {
            const current = queue[head];
            if (distance[current] >= maxDistance) continue;
            for (const next of diagonal ? this.neighbors8(current) : this.neighbors(current)) {
                if (distance[next] !== -1 || !accept(next)) continue;
                distance[next] = distance[current] + 1;
                queue.push(next);
            }
        }
        return distance;
    }

    shuffled(list) {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    /* ---------- Публичный интерфейс: то, чем пользуются рендерер, painter и менеджеры. Логика — в подсистемах ---------- */

    applyTurnState(state) { MapGen.Turn.apply(this, state); }
    applyEconomyState(state) { MapGen.Economy.apply(this, state); }
    applyFactionState(state) { MapGen.Factions.apply(this, state); }

    // Подписки на новое состояние; каждая возвращает функцию отписки.
    onTurnState(listener) { return this.turnChannel.subscribe(listener); }
    onEconomyState(listener) { return this.economyChannel.subscribe(listener); }
    onFactionState(listener) { return this.factionChannel.subscribe(listener); }

    getTileInfo(x, y) { return MapGen.Info.tile(this, x, y); }
    getRegionInfo(regionId) { return MapGen.Info.region(this, regionId); }
    regionTileList(regionId) { return MapGen.Info.regionTiles(this, regionId); }
    regionGraph() { return MapGen.Info.graph(this); }

    get landShare() {
        return this.landTiles.length / (this.size * this.size);
    }

    get regionCount() {
        return Object.keys(this.regionSizes).length;
    }
}
