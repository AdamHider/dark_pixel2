/* ============================================================
   Справочники: что может лежать в клетке карты
   ============================================================ */
   const Terrain = Object.freeze({ DEEP_WATER: 0, SHALLOW_WATER: 1, PLAIN: 2, MOUNTAIN: 3 });
   const Biome = Object.freeze({ TUNDRA: 0, TAIGA: 1, GRASSLAND: 2, STEPPE: 3, DESERT: 4, SAVANNA: 5 });
   const Shore = Object.freeze({ NONE: 0, BEACH: 1, ROCKY: 2, CLIFF: 3 });
   const Resource = Object.freeze({ NONE: 0, WOOD: 1, WHEAT: 2, GOLD: 3, ETHER: 4, IRON: 5, SETTLEMENT: 6 });
   
   // Что даёт каждый ресурс (числа условные — настройте под экономику игры). В клетке бывает только один ресурс.
   const ResourceInfo = Object.freeze({
       [Resource.WHEAT]: { name: 'пшеница', produces: { food: 1 } },
       [Resource.WOOD]: { name: 'дерево', produces: { production: 1 } },
       [Resource.IRON]: { name: 'железная руда', produces: { production: 2 } },
       [Resource.GOLD]: { name: 'золотая руда', produces: { gold: 2 } },
       [Resource.ETHER]: { name: 'эфир', produces: { ether: 1 } },
       [Resource.SETTLEMENT]: { name: 'поселение', produces: { population: 1, gold: 1 } } // население — из map.population[клетка]
   });
   
   // 8 направлений дороги; индекс направления d и 7 - d — противоположные.
   const ROAD_DIRECTIONS = Object.freeze([[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]);
   
   /* ============================================================
      Вспомогательные функции
      ============================================================ */
   const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
   
   // Степень роста клетки (леса, поля) — число от 0 до 1. На карте её видно ступенями: число деревьев в клетке, густота стеблей.
   // Перерисовывать карту нужно, только когда клетка перешла на другую ступень, поэтому ступени одни и для карты, и для отрисовки.
   const GROWTH_STAGES = 4;
   const growthStage = growth => Math.round(clamp(growth) * GROWTH_STAGES);
   
   // Хорошо перемешанный хеш числа (0..2^32): соседние номера клеток дают несвязанные значения. Простое умножение давало
   // «решётчатые» узоры — реки бежали параллельными диагональными полосами.
   function hash32(n) {
       n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
       n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
       return (n ^ (n >>> 16)) >>> 0;
   }
   const lerp = (a, b, t) => a + (b - a) * t;
   
   // Генератор псевдослучайных чисел (mulberry32): один и тот же seed даёт одну и ту же последовательность.
   function createRandom(seed) {
       let state = seed | 0;
       return function random() {
           state = (state + 0x6D2B79F5) | 0;
           let t = Math.imul(state ^ (state >>> 15), 1 | state);
           t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
           return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
       };
   }
   
   // Выравнивает значения до равномерных 0..1 по рангу: самое малое станет 0, самое большое 1.
   // Тогда порог 0.4 честно означает «нижние 40%», независимо от того, как шум «слипается» вокруг 0.5.
   function rankNormalize(values) {
       const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b]);
       const result = new Float32Array(values.length);
       order.forEach((index, rank) => { result[index] = rank / (values.length - 1); });
       return result;
   }
   
   // Значение на заданной доле отсортированного списка (0.5 — медиана).
   function percentile(values, share) {
       const sorted = Float32Array.from(values).sort();
       return sorted[Math.floor(sorted.length * share)];
   }
   
   /* ============================================================
      Плавный шум: даёт значения 0..1, соседние точки похожи друг на друга
      ============================================================ */
   class ValueNoise {
       constructor(seed) {
           const random = createRandom(seed);
           this.lattice = [];
           for (let i = 0; i < 65 * 65; i++) this.lattice.push(random());
       }
   
       latticeValue(ix, iy) {
           return this.lattice[(iy & 63) * 65 + (ix & 63)];
       }
   
       // Одна «октава»: интерполяция между четырьмя ближайшими узлами решётки.
       sample(x, y) {
           const ix = Math.floor(x);
           const iy = Math.floor(y);
           const smooth = t => t * t * (3 - 2 * t);
           const u = smooth(x - ix);
           const v = smooth(y - iy);
           const top = lerp(this.latticeValue(ix, iy), this.latticeValue(ix + 1, iy), u);
           const bottom = lerp(this.latticeValue(ix, iy + 1), this.latticeValue(ix + 1, iy + 1), u);
           return lerp(top, bottom, v);
       }
   
       // Несколько октав: крупные формы + всё более мелкие детали.
       fractal(x, y, octaves) {
           let sum = 0, amplitude = 1, total = 0, frequency = 1;
           for (let i = 0; i < octaves; i++) {
               sum += amplitude * this.sample(x * frequency, y * frequency);
               total += amplitude;
               amplitude /= 2;
               frequency *= 2;
           }
           return sum / total;
       }
   }
   
   /* ============================================================
      MapGenerator
      Хранит карту в плоских массивах: клетка (x, y) — это индекс y * size + x.
      ============================================================ */
   class MapGenerator {
       static get DEFAULTS() {
           return {
               size: 150,                // сторона карты в клетках (значения «по размеру карты» ниже заданы для 300 и пересчитываются)
               seed: 1,
   
               // --- суша и вода ---
               waterShare: 0.58,         // какая доля клеток станет водой
               mountainShare: 0.12,      // какая доля суши станет горами
               shallowWaterDistance: 2,  // вода не дальше N клеток от суши считается мелководьем
               elevationScale: 4,        // масштаб шума высоты (больше — мельче материки)
               elevationOctaves: 5,
               baseElevation: 0.25,      // общий «подъём» рельефа
               islandFalloff: 0.5,       // насколько сильно рельеф падает к краям (мир окружён водой)
               falloffPower: 2.5,        // форма спада к краям (2 — плавно, 4 — «плато» с обрывом у краёв)
               shapeVariety: 0.6,        // 0..1: насколько изрезана форма континента (заливы, полуострова, острова)
               shapeScale: 6,            // размер деталей формы (больше — мельче)
               inlandSeaStrength: 0.35,  // 0 — внутренних морей нет; больше — крупнее и чаще
               inlandSeaScale: 2.5,      // размер внутренних морей (больше — мельче и чаще)
               islandDensity: 0.5,       // 0..1: сколько островков разбросано вокруг материка (0 — только материк)
               islandScale: 14,          // размер островков (больше — мельче)
               ridgeScale: 5,            // масштаб горных хребтов
               ridgeStrength: 0.3,       // насколько хребты поднимают рельеф
               mountainClustering: 0.6,  // 0..1: 0 — тонкие цепи хребтов, 1 — сплошные массивы; посередине — массивы с ущельями
               massifScale: 3,           // размер горных массивов (больше — мельче и чаще)
               ridgeSharpness: 4,        // больше — тоньше и резче хребты
               warpScale: 2.5,           // масштаб «скручивания» координат (делает берега и хребты извилистыми)
               warpStrength: 0.25,       // сила скручивания; 0 — выключить
               minMountainSize: 4,       // горные массивы меньше этого размера (в клетках) превращаются в равнину
               minIslandSize: 12,        // клочки суши меньше этого размера (в клетках) превращаются в воду
   
               // --- климат ---
               temperatureScale: 4,
               temperatureNoise: 0.35,   // разброс температуры вокруг «север холодно, юг жарко»
               altitudeCooling: 0.6,     // насколько высота охлаждает
               moistureScale: 5,
               aridity: 0.15,            // 0..1: доля сухих клеток, где вместо луга степь/пустыня (меньше — меньше степей)
   
               // --- ресурсы ---
               forestScale: 7,           // масштаб крупных лесных массивов (больше — мельче)
               forestShare: 0.34,        // доля карты под крупными лесными массивами
               forestClumpShare: 0.14,    // ...и ещё столько же мелких разрозненных рощ
               woodChance: 0.9,          // шанс дерева в клетке внутри леса
               wheatScale: 9,
               wheatShare: 0.5,          // то же для полей
               wheatClumpShare: 0.14,
               wheatChance: 0.85,
               clumpScale: 16,           // размер мелких рощ и полей (больше — мельче)
   
               // --- редкие ресурсы ---
               foothillDistance: 2,      // руда встречается в горах и на равнине не дальше N клеток от них
               goldScale: 6,
               goldShare: 0.45,          // доля карты, где вообще возможно золото (скопления)
               goldChance: 0.05,         // шанс золота в такой клетке (в предгорьях вдвое меньше)
               ironScale: 5,
               ironShare: 0.5,           // то же для железной руды
               ironChance: 0.16,         // железо встречается заметно чаще золота
               faultScale: 5,            // масштаб «линий разлома», вдоль которых растёт эфир
               etherShare: 0.06,         // доля карты вдоль линий разлома
               etherChance: 0.35,        // шанс эфира на такой клетке
   
               // --- берега ---
               shoreScale: 12,           // размер участков одного типа берега (больше — мельче)
               beachShare: 0.55,         // доля подходящих (низких, тёплых) берегов, которые станут пляжами
               cliffShare: 0.25,         // доля самых высоких берегов, которые станут утёсами (горы у воды — всегда утёсы)
   
               // --- поселения ---
               populationPerHabitability: 10,  // население региона = сумма «обитаемости» его клеток × это число × случайный множитель
               populationVariation: 0.9,       // разброс населения между регионами (больше — больше и крупных городов, и пустых земель)
               settlementMinPopulation: 60,    // население группы меньше этого — поселения нет
               settlementMaxGroup: 4,          // в группе (деревня, город) не больше стольких соседних клеток
               settlementGroupGrowth: 2.2,     // во сколько раз надо увеличить население, чтобы в группе стало на клетку больше
               settlementMaxLevel: 4,          // самый большой уровень клетки (он же число домиков в клетке)
               settlementTileMinPopulation: 58, // население клетки, с которого начинается уровень 1
               settlementTileGrowth: 1.5,      // во сколько раз надо увеличить население клетки, чтобы уровень вырос на 1
               secondSettlementPopulation: 900, // у региона с таким населением и больше будет вторая группа
               settlementSpacing: 2,           // минимум клеток между группами поселений
   
               // --- дороги между поселениями ---
               roads: true,
               roadNeighbors: 3,               // с сколькими ближайшими соседями пробуем соединить каждое поселение
               roadMaxDistance: 28,            // дальше этого (в клетках) дорог не строим
               roadLoopChance: 0.4,            // шанс добавить «петлю» — вторую по близости дорогу, когда связь уже есть
   
               // --- реки и озёра ---
               rainfall: 1,              // сколько воды даёт клетка (во влажных местах больше); больше — больше и шире реки
               riverThresholds: [60, 180, 480], // сколько воды надо, чтобы появился ручей / река / большая река
               riverMeander: 0.012,      // насколько русла отклоняются от «кратчайшего» пути (больше — извилистее)
               lakeDepth: 0.02,          // впадина глубже этого становится озером
               lakeMinSize: 4,           // озёра меньше этого (в клетках) не создаём
               riverCrossingChance: 0.1,  // доля подходящих прямых участков рек, где ставится мост или брод
   
               // --- регионы ---
               regionMinSize: 18,
               regionMaxSize: 22,
               regionMergeBelow: 10,     // регионы меньше этого размера вливаются в самого маленького соседа
               regionIrregularity: 0.6,  // 0 — почти круглые регионы, больше — причудливее границы
               regionBarrierCost: 3,     // насколько горы «мешают» росту региона (границы ложатся по хребтам); реки всегда граница и в регион не входят
               regionBalancePasses: 12,  // сколько раз выравнивать размеры регионов (0 — не выравнивать)
               regionRelaxPasses: 8,     // сколько раз «центровать» регионы вокруг семян: больше — ровнее и круглее формы
               regionSmoothPasses: 3,    // сколько раз сглаживать границы (убирает зубцы и отростки; 0 — не сглаживать)
           };
       }
   
       constructor(options = {}) {
           this.options = { ...MapGenerator.DEFAULTS, ...options };
           this.size = this.options.size;
           this.factionListeners = new Set();            // подписчики на состояние фракций (см. onFactionState); переживают новую генерацию
           this.turnListeners = new Set();               // подписчики на состояние хода (см. onTurnState)
           this.economyListeners = new Set();            // подписчики на состояние экономики (см. onEconomyState)
       }
   
       /* ---------- Главный метод ---------- */
   
       generate(seed = this.options.seed) {
           this.seed = seed;
           this.random = createRandom(seed);
           this.createNoiseLayers();
           this.allocateLayers();
   
           this.generateElevation();
           this.scatterIslands();
           this.generateMoisture();
           this.classifyTerrain();
           this.removeSmallMountains();
           this.removeSmallIslands();
           this.collectLandTiles();
           this.fillDepressions();
           this.computeWaterDepth();
           this.generateTemperature();
           this.assignBiomes();
           this.placeResources();
           this.generateRivers();
           this.classifyShores();
           this.placeRareResources();
           this.placeRiverCrossings();
           this.buildRegions();
           this.placeSettlements();
           this.buildRoads();
           this.clearRoadResources();
           this.initGrowth();
           return this;
       }
   
       // Изначально леса и поля полностью выросли (степень роста 1); дальше её меняет экономика.
       initGrowth() {
           this.growth.fill(0);
           for (let i = 0; i < this.resource.length; i++) {
               if (this.resource[i] === Resource.WOOD || this.resource[i] === Resource.WHEAT) this.growth[i] = 1;
           }
       }
   
       // На дорогах нет ресурсов, леса и полей: дорога проложена через клетку, значит, она расчищена. Клетки поселений остаются.
       clearRoadResources() {
           for (let i = 0; i < this.resource.length; i++) {
               if (this.roadLevel[i] > 0 && this.resource[i] !== Resource.SETTLEMENT) this.resource[i] = Resource.NONE;
           }
       }
   
       createNoiseLayers() {
           this.noise = {
               elevation: new ValueNoise(this.seed + 1),
               ridge: new ValueNoise(this.seed + 2),
               temperature: new ValueNoise(this.seed + 3),
               moisture: new ValueNoise(this.seed + 4),
               warpX: new ValueNoise(this.seed + 5),
               warpY: new ValueNoise(this.seed + 6),
               forest: new ValueNoise(this.seed + 7),
               fertility: new ValueNoise(this.seed + 8),
               shape: new ValueNoise(this.seed + 9),
               basin: new ValueNoise(this.seed + 10),
               regionShape: new ValueNoise(this.seed + 11),
               islands: new ValueNoise(this.seed + 12),
               massif: new ValueNoise(this.seed + 13),
               forestClumps: new ValueNoise(this.seed + 14),
               fertilityClumps: new ValueNoise(this.seed + 15),
               ore: new ValueNoise(this.seed + 16),
               fault: new ValueNoise(this.seed + 17),
               shore: new ValueNoise(this.seed + 18),
               iron: new ValueNoise(this.seed + 19)
           };
       }
   
       allocateLayers() {
           const count = this.size * this.size;
           this.elevation = new Float32Array(count);
           this.moisture = new Float32Array(count);
           this.ridge = new Float32Array(count);         // 0..1: насколько клетка похожа на горный хребет
           this.temperature = new Float32Array(count);
           this.terrain = new Uint8Array(count);
           this.population = new Uint16Array(count);     // население в клетке с поселением
           this.settlementLevel = new Uint8Array(count); // уровень клетки с поселением 1..4 (0 — нет поселения)
           this.settlements = [];                        // по записи на каждую клетку с поселением: { id, groupId, regionId, tile, population, level, center }
           this.settlementGroups = [];                   // группы соседних клеток: { id, regionId, tiles, tile (центр), population }
           this.settlementGroup = new Int16Array(count).fill(-1); // номер группы поселений в клетке, -1 — нет
           this.regionPopulation = {};                   // id региона -> население
           this.roadLevel = new Uint8Array(count);       // 0 — нет дороги, 1..3 — насколько она наезжена
           this.roadLinks = new Uint8Array(count);       // биты: в какие из 8 сторон (ROAD_DIRECTIONS) идёт дорога из клетки
           this.shore = new Uint8Array(count);           // тип берега (Shore) у суши рядом с водой и реками
           this.crossing = new Uint8Array(count);        // 0 — нет, 1 — брод, 2 — каменный мост
           this.mountainHeight = new Float32Array(count); // 0 вне гор; 0.3..1 в горах — по нему рисуется рельеф
           this.massif = new Float32Array(count);        // 0..1: крупные «пятна» для горных массивов
           this.riverTo = new Int32Array(count).fill(-1); // куда течёт река из этой клетки (-1 — не река или сток за краем карты)
           this.riverFlow = new Uint16Array(count);      // сколько воды проходит через клетку (определяет ширину реки)
           this.waterDepth = new Uint8Array(count);      // 0 на суше; в воде — расстояние до ближайшей суши
           this.biome = new Uint8Array(count);
           this.resource = new Uint8Array(count);
           this.river = new Uint8Array(count);           // 0 — реки нет, 1..3 — её глубина
           this.regionId = new Int16Array(count).fill(-1); // -1 — клетка вне региона (вода и реки)
           this.regionSizes = {};                        // id региона -> число клеток
           this.landTiles = [];                          // индексы всех клеток суши
           // Ход и экономика — тоже только данные: их передают turn manager и economy manager (applyTurnState, applyEconomyState).
           this.growth = new Float32Array(count);        // степень роста клетки 0..1: леса и поля (у остальных клеток 0)
           this.turnState = { turn: 0, year: 0, season: null, seasonIndex: 0, turnInSeason: 0, version: 0 };
           this.economyVersion = 0;                      // версия состояния экономики
           this.visualVersion = 0;                       // растёт, только когда экономика изменила то, что видно (ступень роста, уровень поселения)
   
           // Фракции — только данные: их передаёт faction manager (applyFactionState), карта сама ими не управляет.
           this.factions = [];                           // фракции: { id, name, color, capitalRegion, capitalTile }
           this.tileFaction = new Int16Array(count).fill(-1); // кому принадлежит клетка (id фракции), -1 — никому
           this.factionVersion = 0;                      // версия состояния от менеджера: по ней перерисовывается слой фракций
       }
   
       /* ---------- Вспомогательные методы для работы с клетками ---------- */
   
       index(x, y) {
           return y * this.size + x;
       }
   
       // Четыре соседние клетки (вверх, вниз, влево, вправо) внутри карты.
       neighbors(i) {
           const x = i % this.size;
           const y = Math.floor(i / this.size);
           const result = [];
           if (x > 0) result.push(i - 1);
           if (x < this.size - 1) result.push(i + 1);
           if (y > 0) result.push(i - this.size);
           if (y < this.size - 1) result.push(i + this.size);
           return result;
       }
   
       isLand(i) {
           return this.terrain[i] >= Terrain.PLAIN;
       }
   
       /* ---------- 1. Высота ---------- */
   
       // Шум + падение к краям (вода вокруг) + хребты.
       generateElevation() {
           const o = this.options;
           for (let y = 0; y < this.size; y++) {
               for (let x = 0; x < this.size; x++) {
                   const nx = x / this.size;
                   const ny = y / this.size;
   
                   // Квадрат расстояния от центра карты: 0 в центре, 1 на середине края.
                   const dx = (nx - 0.5) * 2;
                   const dy = (ny - 0.5) * 2;
                   const distanceSq = dx * dx + dy * dy;
   
                   // «Скручиваем» координаты: берега и хребты становятся извилистыми, а не расплывчатыми пятнами.
                   const wx = nx + (this.noise.warpX.fractal(nx * o.warpScale, ny * o.warpScale, 2) - 0.5) * o.warpStrength;
                   const wy = ny + (this.noise.warpY.fractal(nx * o.warpScale, ny * o.warpScale, 2) - 0.5) * o.warpStrength;
   
                   const baseNoise = this.noise.elevation.fractal(wx * o.elevationScale, wy * o.elevationScale, o.elevationOctaves);
                   // Спад к краям: чем больше falloffPower, тем ровнее «плато» внутри и тем резче обрыв у краёв.
                   const falloff = Math.pow(Math.sqrt(distanceSq), o.falloffPower) * o.islandFalloff;
                   let height = baseNoise * 0.9 + o.baseElevation - falloff;
   
                   // Регулятор формы: среднемасштабный шум ломает береговую линию —
                   // появляются заливы, полуострова и острова вдали от материка.
                   const shapeNoise = this.noise.shape.fractal(wx * o.shapeScale, wy * o.shapeScale, 3);
                   height += (shapeNoise - 0.5) * o.shapeVariety * 2.4;
   
                   // Внутренние моря: крупные впадины, вырезанные во внутренних областях.
                   const basinNoise = this.noise.basin.fractal(wx * o.inlandSeaScale, wy * o.inlandSeaScale, 2);
                   height -= Math.max(0, basinNoise - 0.5) * 4 * o.inlandSeaStrength * clamp(1.3 - distanceSq);
   
                   // Хребты: линии, где шум близок к 0.5, поднимаем вверх. Возле краёв карты хребты слабее.
                   const ridgeNoise = this.noise.ridge.fractal(wx * o.ridgeScale, wy * o.ridgeScale, 4);
                   const ridge = Math.pow(1 - Math.abs(2 * ridgeNoise - 1), o.ridgeSharpness);
                   height += ridge * o.ridgeStrength * clamp(1.2 - distanceSq);
   
                   const i = this.index(x, y);
                   this.elevation[i] = height;
                   this.ridge[i] = ridge;
                   this.massif[i] = this.noise.massif.fractal(wx * o.massifScale, wy * o.massifScale, 3);
               }
           }
       }
   
       // Острова: в полосе мелководья вокруг материка отдельные «горбы» шума поднимаем над уровнем моря.
       scatterIslands() {
           const o = this.options;
           if (o.islandDensity <= 0) return;
   
           const estimatedSea = percentile(this.elevation, o.waterShare);
           const threshold = 0.72 - 0.16 * o.islandDensity; // выше плотность — ниже порог — больше островов
           for (let y = 0; y < this.size; y++) {
               for (let x = 0; x < this.size; x++) {
                   const i = this.index(x, y);
                   const belowSea = estimatedSea - this.elevation[i];
                   if (belowSea <= 0 || belowSea > 0.15) continue; // только полоса моря недалеко от «почти суши»
   
                   const bump = this.noise.islands.fractal((x / this.size) * o.islandScale, (y / this.size) * o.islandScale, 2);
                   if (bump > threshold) this.elevation[i] = estimatedSea + 0.01 + (bump - threshold) * 0.5;
               }
           }
       }
   
       generateMoisture() {
           const scale = this.options.moistureScale;
           for (let y = 0; y < this.size; y++) {
               for (let x = 0; x < this.size; x++) {
                   this.moisture[this.index(x, y)] =
                       this.noise.moisture.fractal((x / this.size) * scale, (y / this.size) * scale, 4);
               }
           }
           // Выравниваем до равномерных 0..1: порог 0.4 в биомах теперь честно значит «самые сухие 40%».
           this.moisture = rankNormalize(this.moisture);
       }
   
       /* ---------- 2. Вода / равнина / гора ---------- */
   
       // Пороги считаем по долям, а не по абсолютным числам: так соотношение воды и гор не зависит от настроек шума.
       classifyTerrain() {
           const { waterShare, mountainShare } = this.options;
   
           this.seaLevel = percentile(this.elevation, waterShare);
   
           // Горы = «хребтовость» (тонкие линии) + «массивность» (крупные пятна) + чуть высоты.
           // Одни хребты дают тонкие змейки; массивы собирают их в кучи, а между грядами остаются ущелья.
           const landIndices = [];
           for (let i = 0; i < this.elevation.length; i++) {
               if (this.elevation[i] > this.seaLevel) landIndices.push(i);
           }
           const rankOnLand = values => rankNormalize(Float32Array.from(landIndices, i => values[i]));
           const ridgeRank = rankOnLand(this.ridge);
           const massifRank = rankOnLand(this.massif);
           const heightRank = rankOnLand(this.elevation);
   
           const clustering = this.options.mountainClustering;
           const scores = landIndices.map((_, k) =>
               0.85 * ((1 - clustering) * ridgeRank[k] + clustering * massifRank[k]) + 0.15 * heightRank[k]);
           this.mountainLevel = percentile(scores, 1 - mountainShare);
   
           let maxScore = this.mountainLevel;
           for (const score of scores) maxScore = Math.max(maxScore, score);
   
           this.terrain.fill(Terrain.DEEP_WATER);
           landIndices.forEach((i, k) => {
               const isMountain = scores[k] > this.mountainLevel;
               this.terrain[i] = isMountain ? Terrain.MOUNTAIN : Terrain.PLAIN;
               // Высота горы растёт к «хребтовым» и «массивным» клеткам: по ней рисуется рельеф (хребты выше, края ниже).
               if (isMountain) this.mountainHeight[i] = 0.3 + 0.7 * (scores[k] - this.mountainLevel) / (maxScore - this.mountainLevel);
           });
       }
   
       // Одиночная «гора» на равнине выглядит нелепо: горы должны занимать не меньше minMountainSize клеток.
       removeSmallMountains() {
           const visited = new Uint8Array(this.terrain.length);
           for (let start = 0; start < this.terrain.length; start++) {
               if (visited[start] || this.terrain[start] !== Terrain.MOUNTAIN) continue;
   
               const queue = [start];
               visited[start] = 1;
               for (let head = 0; head < queue.length; head++) {
                   for (const neighbor of this.neighbors(queue[head])) {
                       if (visited[neighbor] || this.terrain[neighbor] !== Terrain.MOUNTAIN) continue;
                       visited[neighbor] = 1;
                       queue.push(neighbor);
                   }
               }
               if (queue.length >= this.options.minMountainSize) continue;
               for (const i of queue) {
                   this.terrain[i] = Terrain.PLAIN;
                   this.mountainHeight[i] = 0;
               }
           }
       }
   
       // Шум порождает одиночные клетки и крошечные островки, особенно посреди озёр. Убираем всё, что меньше minIslandSize.
       removeSmallIslands() {
           const visited = new Uint8Array(this.terrain.length);
           for (let start = 0; start < this.terrain.length; start++) {
               if (visited[start] || !this.isLand(start)) continue;
   
               const island = this.collectLandComponent(start, visited);
               if (island.length >= this.options.minIslandSize) continue;
               for (const i of island) {
                   this.terrain[i] = Terrain.DEEP_WATER;
                   this.elevation[i] = Math.min(this.elevation[i], this.seaLevel);
                   this.mountainHeight[i] = 0;
               }
           }
       }
   
       // Все клетки суши, связанные с start (соседи по сторонам).
       collectLandComponent(start, visited) {
           const queue = [start];
           visited[start] = 1;
           for (let head = 0; head < queue.length; head++) {
               for (const neighbor of this.neighbors(queue[head])) {
                   if (visited[neighbor] || !this.isLand(neighbor)) continue;
                   visited[neighbor] = 1;
                   queue.push(neighbor);
               }
           }
           return queue;
       }
   
       collectLandTiles() {
           this.landTiles = [];
           for (let i = 0; i < this.terrain.length; i++) {
               if (this.isLand(i)) this.landTiles.push(i);
           }
       }
   
       // Глубина воды = расстояние до ближайшей суши (в клетках). Работает и для океана, и для озёр:
       // у берега мелко, к середине водоёма всё глубже.
       computeWaterDepth() {
           const queue = this.landTiles.slice();
           for (let head = 0; head < queue.length; head++) {
               const current = queue[head];
               for (const neighbor of this.neighbors8(current)) {
                   if (this.isLand(neighbor) || this.waterDepth[neighbor] !== 0) continue;
                   this.waterDepth[neighbor] = Math.min(255, this.waterDepth[current] + 1);
                   queue.push(neighbor);
               }
           }
   
           // Мелководье — узкая полоса у берега; всё остальное — глубокая вода.
           for (let i = 0; i < this.terrain.length; i++) {
               if (this.isLand(i)) continue;
               const depth = this.waterDepth[i];
               this.terrain[i] = depth > 0 && depth <= this.options.shallowWaterDistance
                   ? Terrain.SHALLOW_WATER : Terrain.DEEP_WATER;
           }
       }
   
       // Восемь соседей, включая диагональных.
       neighbors8(i) {
           const x = i % this.size;
           const y = Math.floor(i / this.size);
           const result = [];
           for (let dy = -1; dy <= 1; dy++) {
               for (let dx = -1; dx <= 1; dx++) {
                   if (dx === 0 && dy === 0) continue;
                   const nx = x + dx, ny = y + dy;
                   if (nx >= 0 && ny >= 0 && nx < this.size && ny < this.size) result.push(ny * this.size + nx);
               }
           }
           return result;
       }
   
       /* ---------- 3. Температура ---------- */
   
       // Север (y = 0) холодный, юг (y = size) жаркий; шум добавляет разнообразия, высота охлаждает.
       generateTemperature() {
           const o = this.options;
           for (let y = 0; y < this.size; y++) {
               for (let x = 0; x < this.size; x++) {
                   const i = this.index(x, y);
                   const latitude = y / this.size;
                   const noise = this.noise.temperature.fractal((x / this.size) * o.temperatureScale, latitude * o.temperatureScale, 3);
                   const altitude = Math.max(0, this.elevation[i] - this.seaLevel);
   
                   const temperature = latitude * 0.9 + 0.05
                       + (noise - 0.5) * o.temperatureNoise
                       - altitude * o.altitudeCooling;
                   this.temperature[i] = clamp(temperature);
               }
           }
       }
   
       /* ---------- 4. Биомы равнин ---------- */
   
       assignBiomes() {
           for (const i of this.landTiles) {
               if (this.terrain[i] === Terrain.PLAIN) {
                   this.biome[i] = this.pickBiome(this.temperature[i], this.moisture[i]);
               }
           }
       }
   
       pickBiome(temperature, moisture) {
           const dry = this.options.aridity; // клетки суше этого порога — степь или пустыня
           if (temperature < 0.1) return Biome.TUNDRA;
   
           if (temperature < 0.42) {                 // холодный пояс
               if (moisture > 0.55) return Biome.TAIGA;
               return moisture > dry * 0.8 ? Biome.GRASSLAND : Biome.STEPPE;
           }
           if (temperature < 0.7) {                  // умеренный пояс
               if (moisture < dry) return Biome.STEPPE;
               return moisture > 0.8 ? Biome.TAIGA : Biome.GRASSLAND;
           }
           // жаркий пояс
           if (moisture < dry) return Biome.DESERT;
           return moisture < 0.6 ? Biome.SAVANNA : Biome.GRASSLAND;
       }
   
       /* ---------- 5. Ресурсы ---------- */
   
       placeResources() {
           const o = this.options;
           const forest = this.createPatchLayer(this.noise.forest, o.forestScale, o.forestShare, this.noise.forestClumps, o.clumpScale, o.forestClumpShare);
           const fields = this.createPatchLayer(this.noise.fertility, o.wheatScale, o.wheatShare, this.noise.fertilityClumps, o.clumpScale, o.wheatClumpShare);
   
           for (const i of this.landTiles) {
               if (this.terrain[i] !== Terrain.PLAIN) continue;
   
               const t = this.temperature[i];
               const m = this.moisture[i];
               const roll = this.random();
   
               const goodForWood = forest[i] && m > 0.3 && t > 0.12 && t < 0.8;
               const goodForWheat = fields[i] && m > 0.1 && m < 0.9 && t > 0.18 && t < 0.85;
   
               if (goodForWood && roll < o.woodChance) this.resource[i] = Resource.WOOD;
               else if (goodForWheat && roll < o.wheatChance) this.resource[i] = Resource.WHEAT;
           }
       }
   
       // «Пятна» ресурса: крупные скопления плюс мелкие разрозненные кучки. Вместе дают хаотичное, но не пустое распределение.
       createPatchLayer(bigNoise, bigScale, bigShare, smallNoise, smallScale, smallShare) {
           const big = this.createDensityLayer(bigNoise, bigScale);
           const small = this.createDensityLayer(smallNoise, smallScale);
           const patches = new Uint8Array(big.length);
           for (let i = 0; i < patches.length; i++) {
               patches[i] = big[i] > 1 - bigShare || small[i] > 1 - smallShare ? 1 : 0;
           }
           return patches;
       }
   
       // Слой «плотности»: плавный шум, выровненный до равномерных значений 0..1.
       createDensityLayer(noise, scale) {
           const layer = new Float32Array(this.size * this.size);
           for (let y = 0; y < this.size; y++) {
               for (let x = 0; x < this.size; x++) {
                   layer[this.index(x, y)] = noise.fractal((x / this.size) * scale, (y / this.size) * scale, 3);
               }
           }
           return rankNormalize(layer);
       }
   
       /* ---------- 5б. Редкие ресурсы ---------- */
   
       placeRareResources() {
           this.placeGold();
           this.placeIron();
           this.placeEther();
       }
   
       // Золото — редкое: в горах и предгорьях, скоплениями. Перекрывает лес и поля.
       placeGold() {
           const o = this.options;
           const nearMountains = this.tilesNearMountains(o.foothillDistance);
           const density = this.createDensityLayer(this.noise.ore, o.goldScale);
   
           for (const i of this.landTiles) {
               if (!nearMountains[i] || this.river[i]) continue;
               const chance = this.terrain[i] === Terrain.MOUNTAIN ? o.goldChance : o.goldChance * 0.5;
               if (density[i] > 1 - o.goldShare && this.random() < chance) this.resource[i] = Resource.GOLD;
           }
       }
   
       // Железо — там же, но другие скопления и заметно чаще; золото не вытесняет.
       placeIron() {
           const o = this.options;
           const nearMountains = this.tilesNearMountains(o.foothillDistance);
           const density = this.createDensityLayer(this.noise.iron, o.ironScale);
   
           for (const i of this.landTiles) {
               if (!nearMountains[i] || this.river[i] || this.resource[i] === Resource.GOLD) continue;
               const chance = this.terrain[i] === Terrain.MOUNTAIN ? o.ironChance : o.ironChance * 0.5;
               if (density[i] > 1 - o.ironShare && this.random() < chance) this.resource[i] = Resource.IRON;
           }
       }
   
       // 1 для гор и для суши не дальше distance клеток от гор (предгорья).
       tilesNearMountains(distance) {
           const near = new Uint8Array(this.terrain.length);
           const reach = new Uint8Array(this.terrain.length);
           const queue = [];
           for (const i of this.landTiles) {
               if (this.terrain[i] === Terrain.MOUNTAIN) {
                   near[i] = 1;
                   queue.push(i);
               }
           }
           for (let head = 0; head < queue.length; head++) {
               const current = queue[head];
               if (reach[current] >= distance) continue;
               for (const neighbor of this.neighbors(current)) {
                   if (near[neighbor] || !this.isLand(neighbor)) continue;
                   near[neighbor] = 1;
                   reach[neighbor] = reach[current] + 1;
                   queue.push(neighbor);
               }
           }
           return near;
       }
   
       // Эфир (гигантские фиолетовые кристаллы и грибы) растёт вдоль «линий разлома» — тонких извилистых полос шума, с разрывами.
       placeEther() {
           const o = this.options;
           const faults = this.createFaultLayer();
   
           for (const i of this.landTiles) {
               if (this.river[i] || this.resource[i] !== Resource.NONE) continue;
               if (faults[i] > 1 - o.etherShare && this.random() < o.etherChance) this.resource[i] = Resource.ETHER;
           }
       }
   
       createFaultLayer() {
           const { faultScale } = this.options;
           const layer = new Float32Array(this.size * this.size);
           for (let y = 0; y < this.size; y++) {
               for (let x = 0; x < this.size; x++) {
                   const n = this.noise.fault.fractal((x / this.size) * faultScale, (y / this.size) * faultScale, 3);
                   layer[this.index(x, y)] = 1 - Math.abs(2 * n - 1); // максимум там, где шум пересекает 0.5, — получаются линии
               }
           }
           return rankNormalize(layer);
       }
   
       /* ---------- 5в. Берега ---------- */
   
       // Тип берега для суши рядом с морем, озером или рекой: пляж, каменистый берег или утёс.
       // Горы у воды — всегда утёсы; низкие тёплые берега — пляжи (пятнами); остальное — камни.
       classifyShores() {
           const o = this.options;
           const coastal = this.landTiles.filter(i =>
               this.river[i] > 0
               || this.neighbors8(i).some(j => !this.isLand(j))
               || this.neighbors(i).some(j => this.river[j] > 0));
           if (coastal.length === 0) return;
   
           const heightRank = rankNormalize(Float32Array.from(coastal, i => this.elevation[i] - this.seaLevel));
           const clusters = this.createDensityLayer(this.noise.shore, o.shoreScale);
           const nearMountains = this.tilesNearMountains(2);
   
           coastal.forEach((i, k) => {
               const warmEnough = this.temperature[i] > 0.2;
               if (nearMountains[i] || heightRank[k] > 1 - o.cliffShare) this.shore[i] = Shore.CLIFF;
               else if (warmEnough && heightRank[k] < 0.65 && clusters[i] > 1 - o.beachShare) this.shore[i] = Shore.BEACH;
               else this.shore[i] = Shore.ROCKY;
           });
       }
   
       /* ---------- 6. Реки и озёра ---------- */
   
       /* Реки — часть рельефа, а не линии, нарисованные поверх: вода стекает по высотам.
          1) «Заливка впадин» (priority-flood): из моря и краёв карты затопляем сушу от низких мест к высоким; так у каждой
             клетки появляется сток (flowTo) к морю, а впадины, которые не имеют стока, становятся озёрами.
          2) Подсчёт стока: дождь выпадает на каждую клетку (во влажных местах больше) и стекает вниз по flowTo; в каждой
             клетке накапливается вода всех клеток выше по течению. Где её много — там река; чем больше воды, тем река шире.
          Получаются притоки, слияния, бассейны — как в природе, а не 16 одиноких ручьёв. */
   
       fillDepressions() {
           const o = this.options;
           const size = this.size;
           const count = size * size;
           const filled = new Float32Array(count);
           const flowTo = new Int32Array(count).fill(-1);
           const done = new Uint8Array(count);
           const heap = new MinHeap();
           const jitter = i => (hash32(i) / 4294967296) * o.riverMeander;  // чтобы русла петляли, а не шли по линейке
   
           for (let i = 0; i < count; i++) {
               const x = i % size, y = Math.floor(i / size);
               const onEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
               if (!this.isLand(i)) {
                   done[i] = 1;
                   filled[i] = this.seaLevel;
                   if (this.neighbors8(i).some(j => this.isLand(j))) heap.push(this.seaLevel, i, 0);
               } else if (onEdge) {
                   done[i] = 1;
                   filled[i] = this.elevation[i] + jitter(i);
                   heap.push(filled[i], i, 0);
               }
           }
           while (heap.size > 0) {
               const [level, current] = heap.pop();
               for (const next of this.neighbors8(current)) {
                   if (done[next]) continue;
                   done[next] = 1;
                   flowTo[next] = current;
                   // Шаг заливки случайный (и длиннее по диагонали): на плоских местах русла петляют, а не бегут параллельными прямыми.
                   const step = 2e-4 * (0.3 + 2 * (hash32(next + 7919) / 4294967296)) * (this.isDiagonal(current, next) ? 1.4 : 1);
                   filled[next] = Math.max(this.elevation[next] + jitter(next), level + step);
                   heap.push(filled[next], next, 0);
               }
           }
           this.filled = filled;
           this.flowTo = flowTo;
   
           // Озёра: впадины достаточной глубины и размера.
           const deep = new Uint8Array(count);
           for (const i of this.landTiles) {
               if (this.terrain[i] === Terrain.PLAIN && filled[i] - this.elevation[i] > o.lakeDepth) deep[i] = 1;
           }
           const seen = new Uint8Array(count);
           for (const start of this.landTiles) {
               if (!deep[start] || seen[start]) continue;
               const queue = [start];
               seen[start] = 1;
               for (let head = 0; head < queue.length; head++) {
                   for (const next of this.neighbors(queue[head])) {
                       if (deep[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
                   }
               }
               if (queue.length < o.lakeMinSize) continue;
               for (const i of queue) {
                   this.terrain[i] = Terrain.DEEP_WATER;
                   this.mountainHeight[i] = 0;
               }
           }
           this.collectLandTiles();
       }
   
       isDiagonal(a, b) {
           return (a % this.size !== b % this.size) && (Math.floor(a / this.size) !== Math.floor(b / this.size));
       }
   
       generateRivers() {
           const o = this.options;
           const count = this.size * this.size;
   
           // Дождь на каждую клетку суши; воду собираем сверху вниз (от высоких клеток к низким), в том числе через озёра.
           const flow = new Float32Array(count);
           const order = [];
           for (let i = 0; i < count; i++) {
               if (this.flowTo[i] !== -1) order.push(i);
               if (this.isLand(i)) flow[i] = o.rainfall * (0.4 + 1.6 * this.moisture[i]) * (this.terrain[i] === Terrain.MOUNTAIN ? 1.3 : 1);
           }
           order.sort((a, b) => this.filled[b] - this.filled[a]);
           for (const i of order) flow[this.flowTo[i]] += flow[i];
   
           const area = (this.size / 300) ** 2;                      // пороги заданы для карты 300×300: на меньшей карте воды набирается меньше
           const [first, second, third] = o.riverThresholds.map(t => t * area);
           for (const i of this.landTiles) {
               if (this.terrain[i] !== Terrain.PLAIN || flow[i] < first) continue;
               this.river[i] = flow[i] >= third ? 3 : flow[i] >= second ? 2 : 1;
               this.riverFlow[i] = Math.min(65535, Math.round(flow[i]));
               this.riverTo[i] = this.flowTo[i];
               this.resource[i] = Resource.NONE;                        // на реке ресурсов нет
           }
       }
   
       // Переправы: на прямых участках рек (вода входит и выходит в одном направлении) изредка ставим мост (река глубже 1) или брод.
       placeRiverCrossings() {
           const size = this.size;
           const upstream = new Map();                                  // клетка -> реки, впадающие в неё
           for (const i of this.landTiles) {
               if (this.river[i] > 0 && this.riverTo[i] !== -1 && this.river[this.riverTo[i]] > 0) {
                   if (!upstream.has(this.riverTo[i])) upstream.set(this.riverTo[i], []);
                   upstream.get(this.riverTo[i]).push(i);
               }
           }
           const direction = (from, to) => [(to % size) - (from % size), Math.floor(to / size) - Math.floor(from / size)];
   
           for (const i of this.landTiles) {
               if (this.river[i] === 0 || this.riverTo[i] === -1 || this.crossing[i]) continue;
               const sources = upstream.get(i) || [];
               if (sources.length !== 1) continue;                       // начало реки или слияние — не место для моста
               const [ax, ay] = direction(sources[0], i), [bx, by] = direction(i, this.riverTo[i]);
               if (ax !== bx || ay !== by) continue;                    // поворот
               if (this.random() > this.options.riverCrossingChance) continue;
               if (this.neighbors8(i).some(j => this.crossing[j])) continue;
               this.crossing[i] = this.river[i] >= 2 ? 2 : 1;
           }
       }
   
       /* ---------- 7. Регионы ---------- */
   
       // Регион — связный кусок суши БЕЗ рек (как и без моря с озёрами). Реки при этом остаются границами: регион не может
       // перешагнуть русло, в том числе по диагонали.
       //
       // Как строим: (1) раскладываем «семена» по каждому массиву суши пропорционально его площади; (2) делим землю между
       // семенами по «стоимости пути» (горы дороже, шум чуть искажает границы); (3) несколько раз двигаем каждое семя в центр
       // своего региона и делим заново (релаксация Ллойда) — именно она превращает случайные клочки в ровные, почти
       // шестиугольные области; (4) чиним обрывки, вливаем мелочь, выравниваем размеры и сглаживаем границы.
       buildRegions() {
           const o = this.options;
           const count = this.size * this.size;
   
           this.regionId.fill(-1);
           this.regionMask = new Uint8Array(count); // 1 — клетка может входить в регион (суша без реки)
           this.regionTiles = [];
           for (const i of this.landTiles) {
               if (this.river[i]) continue;
               this.regionMask[i] = 1;
               this.regionTiles.push(i);
           }
           this.regionSizes = {};
           if (this.regionTiles.length === 0) return;
   
           this.regionCost = this.buildRegionCosts();
           const averageSize = (o.regionMinSize + o.regionMaxSize) / 2;
   
           let seeds = [];
           for (const area of this.regionAreas()) {
               // Остров, который одним регионом вышел бы заметно больше максимума, делим на несколько (соседям такой остров не отдашь).
               const seedCount = Math.max(1, Math.round(area.length / averageSize), Math.ceil(area.length / (o.regionMaxSize * 1.2)));
               seeds.push(...this.pickRegionSeeds(area, seedCount));
           }
           this.nextRegionId = seeds.length;
   
           for (let pass = 0; pass < o.regionRelaxPasses; pass++) {
               this.assignRegions(seeds);
               seeds = this.relaxRegionSeeds(seeds);
           }
           this.assignRegions(seeds);
   
           this.repairRegionConnectivity();
           this.repairRegionConnectivity();
           this.countRegionSizes();
           this.mergeSmallRegions();
           this.balanceRegionSizes();            // выравниваем размеры (излишек перетекает к мелким соседям)
           this.smoothRegionBorders(1, 1);       // убираем зубцы и отростки, почти не выходя за [min, max]
           this.balanceRegionSizes();            // подтягиваем размеры после сглаживания
           this.smoothRegionBorders(1, 1);
           this.renumberRegions();
       }
   
       shuffled(list) {
           const copy = list.slice();
           for (let i = copy.length - 1; i > 0; i--) {
               const j = Math.floor(this.random() * (i + 1));
               [copy[i], copy[j]] = [copy[j], copy[i]];
           }
           return copy;
       }
   
       // Сколько стоит «зайти» в клетку при росте региона: единица, шум (неправильность границ) и горы (преграда).
       buildRegionCosts() {
           const o = this.options;
           const noiseLayer = this.createDensityLayer(this.noise.regionShape, 10);
           const cost = new Float32Array(this.size * this.size);
           for (const i of this.regionTiles) {
               cost[i] = 1 + noiseLayer[i] * 2 * o.regionIrregularity;
               if (this.terrain[i] === Terrain.MOUNTAIN) cost[i] += o.regionBarrierCost;
           }
           return cost;
       }
   
       // Соседи для роста региона: 4 стороны и диагонали (чтобы формы были круглее, а не «ромбами»). Диагональ разрешена,
       // только если обе клетки «за углом» тоже годятся: так регион не просачивается сквозь диагональный изгиб реки или берега.
       regionNeighbors(i) {
           const size = this.size, mask = this.regionMask;
           const x = i % size, y = (i - x) / size;
           const result = [];
           for (let dy = -1; dy <= 1; dy++) {
               for (let dx = -1; dx <= 1; dx++) {
                   if (dx === 0 && dy === 0) continue;
                   const nx = x + dx, ny = y + dy;
                   if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                   const j = ny * size + nx;
                   if (!mask[j]) continue;
                   if (dx !== 0 && dy !== 0 && !(mask[y * size + nx] && mask[ny * size + x])) continue;
                   result.push(j, dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
               }
           }
           return result; // плоский список: [клетка, длина шага, клетка, длина шага, ...]
       }
   
       // Отдельные массивы региональной суши (клетки, между которыми можно пройти не через реку и не через воду).
       regionAreas() {
           const seen = new Uint8Array(this.size * this.size);
           const areas = [];
           for (const start of this.regionTiles) {
               if (seen[start]) continue;
               const area = [start];
               seen[start] = 1;
               for (let head = 0; head < area.length; head++) {
                   for (const neighbor of this.neighbors(area[head])) {
                       if (seen[neighbor] || !this.regionMask[neighbor]) continue;
                       seen[neighbor] = 1;
                       area.push(neighbor);
                   }
               }
               areas.push(area);
           }
           return areas;
       }
   
       // Семена берём случайно, но не вплотную друг к другу (сначала с большим зазором, потом с меньшим), равнинам отдаём предпочтение.
       pickRegionSeeds(area, count) {
           const flat = this.shuffled(area.filter(i => this.terrain[i] !== Terrain.MOUNTAIN));
           const mountains = this.shuffled(area.filter(i => this.terrain[i] === Terrain.MOUNTAIN));
           const order = flat.concat(mountains);
           count = Math.min(count, order.length);
   
           const averageSize = (this.options.regionMinSize + this.options.regionMaxSize) / 2;
           const spacing = Math.max(1, Math.round(Math.sqrt(averageSize) * 0.7));
           const blocked = new Uint8Array(this.terrain.length);
           const seeds = [];
   
           for (let radius = spacing; radius >= 0 && seeds.length < count; radius--) {
               blocked.fill(0);
               for (const seed of seeds) this.markBlocked(blocked, seed, radius);
               for (const i of order) {
                   if (seeds.length >= count) break;
                   if (blocked[i] || seeds.includes(i)) continue;
                   seeds.push(i);
                   this.markBlocked(blocked, i, radius);
               }
           }
           return seeds;
       }
   
       markBlocked(blocked, i, radius) {
           const x = i % this.size;
           const y = Math.floor(i / this.size);
           for (let dy = -radius; dy <= radius; dy++) {
               for (let dx = -radius; dx <= radius; dx++) {
                   const nx = x + dx, ny = y + dy;
                   if (nx >= 0 && ny >= 0 && nx < this.size && ny < this.size) blocked[ny * this.size + nx] = 1;
               }
           }
       }
   
       // Делим землю между семенами: каждая клетка достаётся тому, до кого «дешевле» дойти (Дейкстра от всех семян сразу).
       assignRegions(seeds) {
           this.regionId.fill(-1);
           const dist = new Float32Array(this.size * this.size).fill(Infinity);
           const heap = new MinHeap();
           seeds.forEach((tile, id) => {
               dist[tile] = 0;
               heap.push(0, tile, id);
           });
   
           while (heap.size > 0) {
               const [cost, tile, id] = heap.pop();
               if (this.regionId[tile] !== -1) continue;
               this.regionId[tile] = id;
   
               const steps = this.regionNeighbors(tile);
               for (let k = 0; k < steps.length; k += 2) {
                   const neighbor = steps[k];
                   if (this.regionId[neighbor] !== -1) continue;
                   const next = cost + steps[k + 1] * this.regionCost[neighbor];
                   if (next < dist[neighbor]) {
                       dist[neighbor] = next;
                       heap.push(next, neighbor, id);
                   }
               }
           }
       }
   
       // Новое семя — клетка региона, ближайшая к его «центру тяжести» (лёгкий штраф за горы).
       relaxRegionSeeds(seeds) {
           const tilesByRegion = seeds.map(() => []);
           for (const i of this.regionTiles) {
               const id = this.regionId[i];
               if (id >= 0) tilesByRegion[id].push(i);
           }
           return seeds.map((seed, id) => {
               const tiles = tilesByRegion[id];
               if (tiles.length === 0) return seed;
               let cx = 0, cy = 0;
               for (const i of tiles) {
                   cx += i % this.size;
                   cy += Math.floor(i / this.size);
               }
               cx /= tiles.length;
               cy /= tiles.length;
   
               let best = seed, bestDistance = Infinity;
               for (const i of tiles) {
                   const dx = (i % this.size) - cx, dy = Math.floor(i / this.size) - cy;
                   const distance = dx * dx + dy * dy + (this.terrain[i] === Terrain.MOUNTAIN ? 4 : 0);
                   if (distance < bestDistance) {
                       bestDistance = distance;
                       best = i;
                   }
               }
               return best;
           });
       }
   
       // Регион должен быть цельным (по 4 соседям). Обрывки, отрезанные от основной части, отдаём соседу с самой длинной общей границей.
       repairRegionConnectivity() {
           const seen = new Uint8Array(this.size * this.size);
           const componentsByRegion = {};
           for (const start of this.regionTiles) {
               if (seen[start]) continue;
               const id = this.regionId[start];
               const component = [start];
               seen[start] = 1;
               for (let head = 0; head < component.length; head++) {
                   for (const neighbor of this.neighbors(component[head])) {
                       if (seen[neighbor] || this.regionId[neighbor] !== id) continue;
                       seen[neighbor] = 1;
                       component.push(neighbor);
                   }
               }
               (componentsByRegion[id] ||= []).push(component);
           }
   
           for (const components of Object.values(componentsByRegion)) {
               if (components.length < 2) continue;
               components.sort((a, b) => b.length - a.length);
               for (const fragment of components.slice(1)) {
                   const target = this.bestNeighborRegion(fragment, this.regionId[fragment[0]]);
                   const newId = target !== -1 ? target : this.nextRegionId++;
                   for (const i of fragment) this.regionId[i] = newId;
               }
           }
       }
   
       // Сосед с самой длинной общей границей (при равенстве — меньший).
       bestNeighborRegion(tiles, ownId) {
           const contacts = new Map();
           for (const i of tiles) {
               for (const j of this.neighbors(i)) {
                   const other = this.regionId[j];
                   if (other === -1 || other === ownId) continue;
                   contacts.set(other, (contacts.get(other) || 0) + 1);
               }
           }
           let best = -1, bestContacts = 0;
           for (const [other, n] of contacts) {
               const smaller = best !== -1 && n === bestContacts && (this.regionSizes[other] ?? 0) < (this.regionSizes[best] ?? 0);
               if (n > bestContacts || smaller) {
                   best = other;
                   bestContacts = n;
               }
           }
           return best;
       }
   
       countRegionSizes() {
           this.regionSizes = {};
           for (const i of this.regionTiles) {
               const id = this.regionId[i];
               if (id >= 0) this.regionSizes[id] = (this.regionSizes[id] || 0) + 1;
           }
       }
   
       // Обрывки меньше regionMergeBelow вливаем в соседа (с самой длинной общей границей), начиная с самых мелких.
       mergeSmallRegions() {
           const tilesByRegion = {};
           for (const i of this.regionTiles) {
               (tilesByRegion[this.regionId[i]] ||= []).push(i);
           }
   
           const ids = Object.keys(this.regionSizes).map(Number).sort((a, b) => this.regionSizes[a] - this.regionSizes[b]);
           for (const id of ids) {
               const tiles = tilesByRegion[id];
               if (!tiles || tiles.length >= this.options.regionMergeBelow) continue;
   
               let target = this.bestNeighborRegion(tiles, id);
               if (target === -1) target = this.regionAcrossRiver(tiles, id);
               if (target === -1) continue; // обрывок суши, до которого не добраться даже через реку, — оставляем как есть
   
               for (const i of tiles) this.regionId[i] = target;
               tilesByRegion[target].push(...tiles);
               this.regionSizes[target] += tiles.length;
               delete this.regionSizes[id];
               delete tilesByRegion[id];
           }
       }
   
       // Клочок суши, отрезанный рекой от всего остального, лучше присоединить к региону на другом берегу, чем делать из него
       // отдельный «регион» в пару клеток (река при этом по-прежнему в регион не входит).
       regionAcrossRiver(tiles, ownId) {
           const contacts = new Map();
           for (const i of tiles) {
               for (const river of this.neighbors(i)) {
                   if (!this.river[river]) continue;
                   for (const j of this.neighbors8(river)) {
                       const other = this.regionId[j];
                       if (other !== -1 && other !== ownId) contacts.set(other, (contacts.get(other) || 0) + 1);
                   }
               }
           }
           let best = -1, bestContacts = 0;
           for (const [other, n] of contacts) {
               if (n > bestContacts) {
                   best = other;
                   bestContacts = n;
               }
           }
           return best;
       }
   
       // Сколько из 8 соседей клетки принадлежит региону id.
       regionContacts(tile, id) {
           let n = 0;
           for (const neighbor of this.neighbors8(tile)) if (this.regionId[neighbor] === id) n++;
           return n;
       }
   
       // Выравниваем размеры: граничные клетки переходят от слишком больших регионов к слишком маленьким. Сначала идут клетки,
       // которые «и так почти внутри» получателя (так граница не обрастает отростками); клетку не отдаём, если донор развалится.
       balanceRegionSizes() {
           const { regionMinSize, regionMaxSize, regionBalancePasses } = this.options;
           const needed = (donor, receiver) => {
               const donorSize = this.regionSizes[donor], receiverSize = this.regionSizes[receiver];
               // Излишек перетекает «по цепочке» к более мелким соседям: слишком большой регион отдаёт клетки любому соседу, который
               // меньше него хотя бы на 2, а слишком маленький берёт у любого соседа, который больше него хотя бы на 2.
               return (donorSize > regionMaxSize && receiverSize < donorSize - 1) || (receiverSize < regionMinSize && donorSize > receiverSize + 1);
           };
   
           for (let pass = 0; pass < regionBalancePasses; pass++) {
               const moves = [];
               for (const tile of this.regionTiles) {
                   const donor = this.regionId[tile];
                   let best = -1, bestScore = -Infinity;
                   for (const neighbor of this.neighbors(tile)) {
                       const receiver = this.regionId[neighbor];
                       if (receiver === -1 || receiver === donor || !needed(donor, receiver)) continue;
                       const toReceiver = this.regionContacts(tile, receiver);
                       if (toReceiver < 2) continue;
                       const score = toReceiver - this.regionContacts(tile, donor) + (hash32(tile) / 4294967296) * 0.01;
                       if (score > bestScore) {
                           bestScore = score;
                           best = receiver;
                       }
                   }
                   if (best !== -1) moves.push([bestScore, tile, best]);
               }
               moves.sort((a, b) => b[0] - a[0]);
   
               let moved = 0;
               for (const [, tile, receiver] of moves) {
                   const donor = this.regionId[tile];
                   if (donor === receiver || !needed(donor, receiver)) continue;
                   if (!this.neighbors(tile).some(n => this.regionId[n] === receiver)) continue;
                   if (this.regionContacts(tile, receiver) < 2) continue;
                   if (!this.staysConnectedWithout(tile, donor)) continue;
   
                   this.regionId[tile] = receiver;
                   this.regionSizes[donor]--;
                   this.regionSizes[receiver]++;
                   moved++;
               }
               if (moved === 0) break;
           }
       }
   
       // Сглаживание: клетка, у которой среди 8 соседей больше «чужих» одного региона, чем «своих», переходит к нему.
       // Убирает зубцы и узкие отростки, границы становятся плавными. Размеры при этом могут чуть выйти за [min, max] — потом их подтягивает выравнивание.
       smoothRegionBorders(minFactor, maxFactor) {
           const { regionMinSize, regionMaxSize, regionSmoothPasses } = this.options;
           // Допуск по размеру: регион не уменьшаем меньше floor и не увеличиваем больше ceiling.
           const floor = minFactor === 1 ? regionMinSize - 1 : Math.floor(regionMinSize * minFactor);
           const ceiling = maxFactor === 1 ? regionMaxSize + 1 : Math.ceil(regionMaxSize * maxFactor);
   
           for (let pass = 0; pass < regionSmoothPasses; pass++) {
               let moved = 0;
               for (const tile of this.shuffled(this.regionTiles)) {
                   const own = this.regionId[tile];
                   const counts = new Map();
                   for (const neighbor of this.neighbors8(tile)) {
                       const id = this.regionId[neighbor];
                       if (id !== -1) counts.set(id, (counts.get(id) || 0) + 1);
                   }
                   const ownCount = counts.get(own) || 0;
   
                   let best = -1, bestCount = ownCount;
                   for (const [id, n] of counts) {
                       if (id !== own && n > bestCount && this.neighbors(tile).some(j => this.regionId[j] === id)) {
                           best = id;
                           bestCount = n;
                       }
                   }
                   if (best === -1) continue;
                   if (this.regionSizes[own] - 1 < floor || this.regionSizes[best] + 1 > ceiling) continue;
                   if (!this.staysConnectedWithout(tile, own)) continue;
   
                   this.regionId[tile] = best;
                   this.regionSizes[own]--;
                   this.regionSizes[best]++;
                   moved++;
               }
               if (moved === 0) break;
           }
       }
   
       // Не расколется ли регион, если убрать из него клетку removed: все её соседи по региону должны остаться связанными между собой.
       // (Регион с карманом за рекой уже состоит из двух кусков — для него проверяем только тот кусок, где лежит клетка.)
       staysConnectedWithout(removed, id) {
           const own = this.neighbors(removed).filter(n => this.regionId[n] === id);
           if (own.length <= 1) return true;
   
           const seen = new Set([removed, own[0]]);
           const queue = [own[0]];
           let reached = 1;
           for (let head = 0; head < queue.length && reached < own.length; head++) {
               for (const neighbor of this.neighbors(queue[head])) {
                   if (this.regionId[neighbor] !== id || seen.has(neighbor)) continue;
                   seen.add(neighbor);
                   queue.push(neighbor);
                   if (own.includes(neighbor)) reached++;
               }
           }
           return reached === own.length;
       }
   
       // Номера регионов подряд: 0, 1, 2, ... (после слияний в нумерации остаются дыры).
       renumberRegions() {
           const mapping = new Map();
           for (const i of this.regionTiles) {
               const id = this.regionId[i];
               if (id === -1) continue;
               if (!mapping.has(id)) mapping.set(id, mapping.size);
               this.regionId[i] = mapping.get(id);
           }
           this.countRegionSizes();
       }
   
       /* ---------- 8. Поселения и дороги ---------- */
   
       /* Поселение — ресурс клетки (как пшеница или руда): в клетке либо оно, либо другой ресурс. Оно даёт население
          и золото. Поселения стоят ГРУППАМИ из 1–4 соседних клеток (деревня, городок), и у каждой клетки группы свой
          уровень 1–4 (он же число домиков в клетке, в painter). Вместе клетки образуют один населённый пункт.
          Население региона зависит от «обитаемости» его клеток: плодородные луга, поля, места у рек и побережья — много,
          пустыня, тундра и горы — мало. Чем больше население, тем больше клеток в группе, а населения самой клетки хватает
          на более высокий уровень. Большому региону достаётся ещё и вторая группа. */
       placeSettlements() {
           const o = this.options;
           const habitability = this.computeHabitability();
   
           const tilesByRegion = {};
           const sums = {};
           for (const i of this.landTiles) {
               const id = this.regionId[i];
               if (id < 0) continue; // клетки рек в регионы не входят
               (tilesByRegion[id] ||= []).push(i);
               sums[id] = (sums[id] || 0) + habitability[i];
           }
   
           const candidates = [];
           for (const key of Object.keys(sums)) {
               const id = Number(key);
               const gauss = (this.random() + this.random() + this.random() - 1.5) / 0.5; // ≈ нормальное распределение
               const population = Math.round(sums[id] * o.populationPerHabitability * Math.exp(gauss * o.populationVariation));
               this.regionPopulation[id] = population;
               if (population >= o.settlementMinPopulation) candidates.push({ regionId: id, population });
           }
   
           // Крупные группы ставим первыми: они занимают лучшие места, мелкие устраиваются вокруг.
           candidates.sort((a, b) => b.population - a.population);
           const blocked = new Uint8Array(this.terrain.length);
           for (const candidate of candidates) {
               const shares = candidate.population >= o.secondSettlementPopulation ? [0.62, 0.38] : [1];
               for (const share of shares) {
                   const population = Math.round(candidate.population * share);
                   if (population < o.settlementMinPopulation) continue;
                   const group = this.growSettlementGroup(candidate.regionId, tilesByRegion[candidate.regionId], habitability, blocked, population);
                   if (group) this.commitSettlementGroup(group, population, blocked);
               }
           }
       }
   
       // Уровень клетки (1..settlementMaxLevel) по её населению: каждое увеличение в settlementTileGrowth раз добавляет уровень.
       settlementLevelFor(population) {
           const o = this.options;
           const level = 1 + Math.floor(Math.log(Math.max(1, population) / o.settlementTileMinPopulation) / Math.log(o.settlementTileGrowth));
           return clamp(level, 1, o.settlementMaxLevel);
       }
   
       // Подходит ли клетка под поселение.
       isSettlementSite(i, regionId, habitability, blocked) {
           return this.terrain[i] === Terrain.PLAIN && !this.river[i] && !blocked[i] && habitability[i] > 0
               && this.regionId[i] === regionId && this.shore[i] !== Shore.CLIFF
               && ![Resource.GOLD, Resource.IRON, Resource.ETHER, Resource.SETTLEMENT].includes(this.resource[i]);
       }
   
       // Выбирает лучшую клетку региона и наращивает вокруг неё группу из соседних клеток (до settlementMaxGroup).
       growSettlementGroup(regionId, regionTiles, habitability, blocked, population) {
           const o = this.options;
           let center = -1;
           let best = -Infinity;
           for (const i of regionTiles) {
               if (!this.isSettlementSite(i, regionId, habitability, blocked)) continue;
               const score = habitability[i] + this.random() * 0.3;
               if (score > best) { best = score; center = i; }
           }
           if (center === -1) return null;
   
           const wanted = clamp(1 + Math.floor(Math.log(population / o.settlementMinPopulation) / Math.log(o.settlementGroupGrowth)), 1, o.settlementMaxGroup);
           const tiles = [center];
           const parents = [-1];
           const inside = new Set(tiles);
           while (tiles.length < wanted) {
               let next = -1, parent = -1, nextScore = -Infinity;
               for (const tile of tiles) {
                   for (const neighbor of this.neighbors(tile)) {
                       if (inside.has(neighbor) || !this.isSettlementSite(neighbor, regionId, habitability, blocked)) continue;
                       const score = habitability[neighbor] + this.random() * 0.3;
                       if (score > nextScore) { nextScore = score; next = neighbor; parent = tile; }
                   }
               }
               if (next === -1) break;                                  // дальше расти некуда: вода, горы, соседний регион
               tiles.push(next);
               parents.push(parent);
               inside.add(next);
           }
           return { tiles, parents };
       }
   
       // Записывает группу: делит население между клетками (центр — больше всех), задаёт уровни и соединяет клетки дорожками.
       commitSettlementGroup(group, population, blocked) {
           const size = this.size;
           const groupId = this.settlementGroups.length;
           const weights = group.tiles.map((_, k) => (k === 0 ? 1.4 : 0.6 + this.random() * 0.8));
           const total = weights.reduce((a, b) => a + b, 0);
   
           group.tiles.forEach((tile, k) => {
               const tilePopulation = Math.max(1, Math.round(population * weights[k] / total));
               const level = this.settlementLevelFor(tilePopulation);
               this.settlements.push({ id: this.settlements.length, groupId, regionId: this.regionId[tile], tile, population: tilePopulation, level, center: k === 0 });
               this.resource[tile] = Resource.SETTLEMENT;
               this.population[tile] = Math.min(65535, tilePopulation);
               this.settlementLevel[tile] = level;
               this.settlementGroup[tile] = groupId;
               if (group.parents[k] !== -1) this.carveRoad([group.parents[k], tile]);   // дорожка между соседними клетками группы
           });
           this.settlementGroups.push({ id: groupId, regionId: this.regionId[group.tiles[0]], tiles: group.tiles, tile: group.tiles[0], population });
   
           const spacing = this.options.settlementSpacing;
           for (const tile of group.tiles) {
               const x = tile % size, y = Math.floor(tile / size);
               for (let dy = -spacing; dy <= spacing; dy++) {
                   for (let dx = -spacing; dx <= spacing; dx++) {
                       const nx = x + dx, ny = y + dy;
                       if (nx >= 0 && ny >= 0 && nx < size && ny < size) blocked[ny * size + nx] = 1;
                   }
               }
           }
       }
   
       // Насколько клетка подходит для жизни: 0 (горы, вода) .. ~1.6 (плодородный луг у реки).
       computeHabitability() {
           const byBiome = {
               [Biome.GRASSLAND]: 1, [Biome.SAVANNA]: 0.65, [Biome.STEPPE]: 0.6,
               [Biome.TAIGA]: 0.55, [Biome.TUNDRA]: 0.15, [Biome.DESERT]: 0.1
           };
           const habitability = new Float32Array(this.terrain.length);
           for (const i of this.landTiles) {
               if (this.terrain[i] !== Terrain.PLAIN) continue;
               let value = byBiome[this.biome[i]] * (0.6 + 0.4 * this.moisture[i]);
               if (this.resource[i] === Resource.WHEAT) value += 0.35;
               else if (this.resource[i] === Resource.WOOD) value += 0.1;
               if (this.neighbors(i).some(j => this.river[j] > 0)) value += 0.35;                 // вода для питья и торговли
               if (this.neighbors8(i).some(j => !this.isLand(j))) value += 0.2;                   // берег
               if (this.shore[i] === Shore.CLIFF) value -= 0.2;
               habitability[i] = clamp(value, 0, 1.6);
           }
           return habitability;
       }
   
       /* Дороги между поселениями по всей карте. Каждое поселение соединяется с ближайшими соседями; рёбра берутся по
          возрастанию длины, и в «каркас» попадают те, что связывают ещё не связанные группы (как остовное дерево), плюс
          несколько ближайших пар для петель. Путь ищет A*: горы и вода непроходимы, лес и подъёмы замедляют, а чужие
          дороги дёшевы — поэтому дороги сливаются в магистрали. Где дорога пересекает реку, ставится мост или брод. */
       buildRoads() {
           const o = this.options;
           const list = this.settlementGroups;
           if (!o.roads || list.length < 2) return;
   
           // 1) кандидаты в рёбра: K ближайших соседей каждого поселения
           const coords = list.map(s => [s.tile % this.size, Math.floor(s.tile / this.size)]);
           const edges = [];
           const seen = new Set();
           const bucketSize = 16;
           const buckets = new Map();
           coords.forEach(([x, y], id) => {
               const key = Math.floor(x / bucketSize) + ',' + Math.floor(y / bucketSize);
               if (!buckets.has(key)) buckets.set(key, []);
               buckets.get(key).push(id);
           });
           const roadMaxDistance = o.roadMaxDistance * this.size / 300;   // дальность дорог растёт вместе с картой
           const reach = Math.ceil(roadMaxDistance / bucketSize);
   
           coords.forEach(([x, y], id) => {
               const near = [];
               for (let by = Math.floor(y / bucketSize) - reach; by <= Math.floor(y / bucketSize) + reach; by++) {
                   for (let bx = Math.floor(x / bucketSize) - reach; bx <= Math.floor(x / bucketSize) + reach; bx++) {
                       for (const other of buckets.get(bx + ',' + by) || []) {
                           if (other === id) continue;
                           const distance = Math.hypot(coords[other][0] - x, coords[other][1] - y);
                           if (distance <= roadMaxDistance) near.push({ other, distance });
                       }
                   }
               }
               near.sort((a, b) => a.distance - b.distance);
               near.slice(0, o.roadNeighbors).forEach(({ other, distance }, rank) => {
                   const key = Math.min(id, other) * 100000 + Math.max(id, other);
                   if (seen.has(key)) return;
                   seen.add(key);
                   edges.push({ a: id, b: other, distance, rank });
               });
           });
           edges.sort((p, q) => p.distance - q.distance);
   
           // 2) каркас (связываем несвязанное) + петли (ближайшие пары)
           const parent = list.map((_, i) => i);
           const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
           for (const edge of edges) {
               const joins = find(edge.a) !== find(edge.b);
               const loop = !joins && (edge.rank === 0 || (edge.rank === 1 && this.random() < o.roadLoopChance));
               if (!joins && !loop) continue;
   
               const path = this.findRoadPath(list[edge.a].tile, list[edge.b].tile);
               if (!path) continue;                                  // например, через море
               if (joins) parent[find(edge.a)] = find(edge.b);
               this.carveRoad(path);
           }
       }
   
       // Поиск пути A* от клетки к клетке; null, если пути нет.
       findRoadPath(start, goal) {
           const size = this.size;
           const count = size * size;
           if (!this.searchCost) {
               this.searchCost = new Float32Array(count);
               this.searchStamp = new Int32Array(count);
               this.searchFrom = new Int32Array(count);
               this.searchRun = 0;
           }
           const cost = this.searchCost, stamp = this.searchStamp, from = this.searchFrom;
           const run = ++this.searchRun;
           const goalX = goal % size, goalY = Math.floor(goal / size);
           const heuristic = i => Math.hypot((i % size) - goalX, Math.floor(i / size) - goalY) * 0.4;
   
           const heap = new MinHeap();
           cost[start] = 0;
           stamp[start] = run;
           from[start] = -1;
           heap.push(heuristic(start), start, 0);
   
           while (heap.size > 0) {
               const [, current, spent] = heap.pop();
               if (spent > cost[current] + 1e-6) continue;           // устаревшая запись
               if (current === goal) {
                   const path = [];
                   for (let i = goal; i !== -1; i = from[i]) path.push(i);
                   return path.reverse();
               }
   
               const x = current % size, y = Math.floor(current / size);
               for (let dy = -1; dy <= 1; dy++) {
                   for (let dx = -1; dx <= 1; dx++) {
                       if (dx === 0 && dy === 0) continue;
                       const nx = x + dx, ny = y + dy;
                       if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                       const next = ny * size + nx;
   
                       const step = this.roadStepCost(current, next, dx !== 0 && dy !== 0, x, y, dx, dy);
                       if (step === Infinity) continue;
                       const total = cost[current] + step;
                       if (stamp[next] !== run || total < cost[next]) {
                           stamp[next] = run;
                           cost[next] = total;
                           from[next] = current;
                           heap.push(total + heuristic(next), next, total);
                       }
                   }
               }
           }
           return null;
       }
   
       // Цена шага по дороге в клетку next (Infinity — нельзя).
       roadStepCost(current, next, diagonal, x, y, dx, dy) {
           if (this.terrain[next] !== Terrain.PLAIN) return Infinity;           // вода и горы
           if (this.river[current] && this.river[next]) return Infinity;        // с клетки реки на клетку реки не шагаем: дорога заезжает на реку, только чтобы пересечь её
           if (diagonal) {                                                      // по диагонали нельзя «срезать угол» воды, гор и рек
               for (const j of [y * this.size + x + dx, (y + dy) * this.size + x]) {
                   if (this.terrain[j] !== Terrain.PLAIN || this.river[j]) return Infinity;
               }
           }
   
           let cost = diagonal ? 1.414 : 1;
           if (this.river[next]) cost += 3;                                     // мост — дорого
           if (this.resource[next] === Resource.WOOD) cost *= 1.5;
           else if (this.resource[next] === Resource.WHEAT) cost *= 1.15;
           else if (this.resource[next] === Resource.GOLD || this.resource[next] === Resource.IRON || this.resource[next] === Resource.ETHER) cost *= 5;   // руды и эфир дороги не пересекают: на дороге ресурсов нет, жалко терять
           if (this.biome[next] === Biome.TUNDRA || this.biome[next] === Biome.DESERT) cost *= 1.4;
           cost += Math.abs(this.elevation[next] - this.elevation[current]) * 12; // подъёмы
           if (this.roadLevel[next] > 0) cost *= 0.4;                           // готовые дороги дёшевы
           return cost;
       }
   
       // Сохраняет путь: уровень дороги в клетках (где дорогу используют несколько путей — выше), связи с соседями и мосты через реки.
       carveRoad(path) {
           const size = this.size;
           const direction = (from, to) => {
               const dx = (to % size) - (from % size), dy = Math.floor(to / size) - Math.floor(from / size);
               return ROAD_DIRECTIONS.findIndex(([ax, ay]) => ax === dx && ay === dy);
           };
   
           path.forEach((tile, k) => {
               this.roadLevel[tile] = Math.min(3, this.roadLevel[tile] + 1);
               if (this.river[tile] > 0 && this.crossing[tile] === 0) this.crossing[tile] = this.river[tile] >= 2 ? 2 : 1;
               if (k === 0) return;
               const previous = path[k - 1];
               const forward = direction(previous, tile);
               this.roadLinks[previous] |= 1 << forward;
               this.roadLinks[tile] |= 1 << (7 - forward);                      // противоположное направление в списке — зеркальный индекс
           });
       }
   
       /* ---------- Ход и экономика: только данные ---------- */
   
       /* Ходами и экономикой управляют отдельные модули (turn-manager.js, economy-manager.js). Они передают сюда готовое
          состояние, карта его хранит, показывает и оповещает подписчиков (рендерер сам меняет сезон и перерисовывается).
   
          Ход: state = { turn, year, season, seasonIndex, turnInSeason, version } — текущее время; сезон показывает рендерер. */
       applyTurnState(state) {
           this.turnState = { ...state, version: state.version === undefined ? this.turnState.version + 1 : state.version };
           for (const listener of [...this.turnListeners]) listener(this.turnState);
       }
   
       onTurnState(listener) {
           this.turnListeners.add(listener);
           return () => this.turnListeners.delete(listener);
       }
   
       /* Экономика: state — любое из:
            growth: Float32Array          степень роста каждой клетки 0..1 (леса, поля)
            population: Uint16Array       население каждой клетки (учитывается только у клеток с поселением)
            resourceChanges: [{ tile, resource }]   лес или поле появились или исчезли (Resource.NONE / WOOD / WHEAT)
            version
          Все остальные поля карты (рельеф, дороги, поселения как места) не меняются. Сама карта пересчитывает только производное:
          уровень поселения (по населению), население групп и регионов. Данные копируются.
          Слушателям уходит { visualChanged }: true, если изменилось то, что видно на карте (ступень роста, уровень поселения,
          появился или исчез лес или поле) — только тогда имеет смысл перерисовывать карту. */
       applyEconomyState({ growth, population, resourceChanges, version } = {}) {
           const total = this.growth.length;
           if ((growth && growth.length !== total) || (population && population.length !== total)) throw new Error('Данные экономики не подходят к этой карте');
           const allowed = [Resource.NONE, Resource.WOOD, Resource.WHEAT];
           for (const change of resourceChanges || []) {
               if (!this.isLand(change.tile) || !allowed.includes(change.resource) || !allowed.includes(this.resource[change.tile])) {
                   throw new Error(`Нельзя менять ресурс клетки ${change.tile}: можно только лес, поле или пусто`);
               }
           }
   
           let visual = false;
           for (const change of resourceChanges || []) {
               if (this.resource[change.tile] === change.resource) continue;
               this.resource[change.tile] = change.resource;
               visual = true;
           }
           if (growth) {
               for (let i = 0; i < total; i++) {
                   if (!Number.isFinite(growth[i])) continue;                // нечисловое значение игнорируем, клетка остаётся как была
                   const value = clamp(growth[i]);
                   if (this.growth[i] === value) continue;
                   if (growthStage(this.growth[i]) !== growthStage(value) && (this.resource[i] === Resource.WOOD || this.resource[i] === Resource.WHEAT)) visual = true;
                   this.growth[i] = value;
               }
           }
           if (population) {
               const groupTotals = new Map(), regionTotals = new Map();
               for (const settlement of this.settlements) {
                   const tile = settlement.tile;
                   const raw = population[tile];
                   const value = Number.isFinite(raw) ? Math.max(0, Math.min(65535, Math.round(raw))) : this.population[tile];
                   this.population[tile] = value;
                   settlement.population = value;
                   const level = this.settlementLevelFor(value);
                   if (level !== this.settlementLevel[tile]) {
                       this.settlementLevel[tile] = level;
                       visual = true;
                   }
                   settlement.level = level;
                   groupTotals.set(settlement.groupId, (groupTotals.get(settlement.groupId) || 0) + value);
                   regionTotals.set(settlement.regionId, (regionTotals.get(settlement.regionId) || 0) + value);
               }
               for (const [groupId, sum] of groupTotals) this.settlementGroups[groupId].population = sum;
               for (const [regionId, sum] of regionTotals) this.regionPopulation[regionId] = sum;
           }
   
           this.economyVersion = version === undefined ? this.economyVersion + 1 : version;
           if (visual) this.visualVersion++;
           for (const listener of [...this.economyListeners]) listener({ visualChanged: visual, version: this.economyVersion });
       }
   
       onEconomyState(listener) {
           this.economyListeners.add(listener);
           return () => this.economyListeners.delete(listener);
       }
   
       /* ---------- Фракции: только данные ---------- */
   
       /* Карта фракциями не управляет. Фракции, владение клетками, правила и ресурсы живут в faction manager
          (faction-manager.js), а сюда он передаёт готовое состояние. Карта его хранит, показывает в getTileInfo / getRegionInfo
          и отдаёт отрисовке (слой фракций), а при каждом новом состоянии оповещает подписчиков (так рендерер перерисовывается сам).
   
          state = { factions: [{ id, name, color, capitalRegion, capitalTile }], tileFaction: Int16Array (id фракции или -1 на клетку),
                    version }
          Данные копируются: менеджер остаётся единственным владельцем состояния. */
       applyFactionState({ factions, tileFaction, version }) {
           if (!tileFaction || tileFaction.length !== this.tileFaction.length) throw new Error('tileFaction не подходит к этой карте');
           this.factions = factions.map(f => ({ ...f }));
           this.tileFaction = Int16Array.from(tileFaction);
           this.factionVersion = version === undefined ? this.factionVersion + 1 : version;
           for (const listener of [...this.factionListeners]) listener(this);
       }
   
       // Подписка на новое состояние фракций; возвращает функцию отписки.
       onFactionState(listener) {
           this.factionListeners.add(listener);
           return () => this.factionListeners.delete(listener);
       }
   
       /* Топология регионов (нужна и фракциям, и всему остальному): клетки региона и соседство регионов. */
   
       regionTileList(regionId) {
           return this.landTiles.filter(i => this.regionId[i] === regionId);
       }
   
       // Соседство регионов: общая граница или соседи через реку (регионы на разных берегах — тоже соседи). Map: id -> Set соседей.
       regionGraph() {
           const graph = new Map();
           const link = (a, b) => {
               if (a < 0 || b < 0 || a === b) return;
               graph.get(a).add(b);
               if (!graph.has(b)) graph.set(b, new Set());
               graph.get(b).add(a);
           };
           for (const i of this.landTiles) {
               const a = this.regionId[i];
               if (a < 0) continue;
               if (!graph.has(a)) graph.set(a, new Set());
               for (const j of this.neighbors8(i)) {
                   const b = this.regionId[j];
                   if (b >= 0) link(a, b);
                   else if (this.river[j] > 0) for (const k of this.neighbors8(j)) link(a, this.regionId[k]);
               }
           }
           return graph;
       }
   
       /* ---------- Сводка по региону (для интерфейса) ---------- */
   
       getRegionInfo(regionId) {
           if (regionId < 0) return null;
           const tiles = this.landTiles.filter(i => this.regionId[i] === regionId);
           const info = {
               id: regionId,
               tiles,
               size: tiles.length,
               mountains: 0,
               riverTiles: 0,
               population: this.regionPopulation[regionId] || 0,
               settlements: [],
               coastal: false,
               resources: [0, 0, 0, 0, 0, 0, 0],   // по кодам Resource (0 — клетки без ресурса)
               biomes: [0, 0, 0, 0, 0, 0],   // по кодам Biome (без гор)
               owners: {},                   // id фракции -> сколько клеток региона ей принадлежит
               owner: -1                     // фракция, которой принадлежит весь регион целиком (иначе -1)
           };
           info.settlements = this.settlements.filter(s => s.regionId === regionId);
           const riverTiles = new Set();
           for (const i of tiles) {
               const faction = this.tileFaction[i];
               if (faction >= 0) info.owners[faction] = (info.owners[faction] || 0) + 1;
               if (this.terrain[i] === Terrain.MOUNTAIN) info.mountains++;
               else info.biomes[this.biome[i]]++;
               for (const j of this.neighbors(i)) if (this.river[j]) riverTiles.add(j); // реки в регион не входят — считаем те, что его омывают
               info.resources[this.resource[i]]++;
               if (this.neighbors(i).some(j => !this.isLand(j))) info.coastal = true;
           }
           info.riverTiles = riverTiles.size;
           const ownerIds = Object.keys(info.owners);
           if (ownerIds.length === 1 && info.owners[ownerIds[0]] === tiles.length) info.owner = Number(ownerIds[0]);
           return info;
       }
   
       /* ---------- Сводка по клетке (для интерфейса) ---------- */
   
       getTileInfo(x, y) {
           if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
           const i = this.index(x, y);
           const regionId = this.regionId[i];
           return {
               x, y,
               terrain: this.terrain[i],
               biome: this.biome[i],
               temperature: this.temperature[i],
               resource: this.resource[i],
               hasRiver: this.river[i] > 0,
               riverLevel: this.river[i],
               population: this.population[i],
               settlementLevel: this.settlementLevel[i],
               settlementGroupSize: this.settlementGroup[i] >= 0 ? this.settlementGroups[this.settlementGroup[i]].tiles.length : 0,
               roadLevel: this.roadLevel[i],
               shore: this.shore[i],
               crossing: this.crossing[i],
               waterDepth: this.waterDepth[i],
               regionId,
               regionSize: regionId >= 0 ? this.regionSizes[regionId] : 0,
               growth: this.growth[i],                   // степень роста леса или поля 0..1
               factionId: this.tileFaction[i]            // -1 — клетка никому не принадлежит
           };
       }
   
       get landShare() {
           return this.landTiles.length / (this.size * this.size);
       }
   
       get regionCount() {
           return Object.keys(this.regionSizes).length;
       }
   }
   
   /* ============================================================
      Очередь с приоритетом (двоичная куча): достаёт самый «дешёвый» элемент. Нужна для роста регионов.
      ============================================================ */
   class MinHeap {
       constructor() {
           this.items = [];
       }
   
       get size() {
           return this.items.length;
       }
   
       push(cost, tile, region) {
           const items = this.items;
           items.push([cost, tile, region]);
           let i = items.length - 1;
           while (i > 0) {
               const parent = (i - 1) >> 1;
               if (items[parent][0] <= items[i][0]) break;
               [items[parent], items[i]] = [items[i], items[parent]];
               i = parent;
           }
       }
   
       pop() {
           const items = this.items;
           const top = items[0];
           const last = items.pop();
           if (items.length > 0) {
               items[0] = last;
               let i = 0;
               for (;;) {
                   const left = 2 * i + 1, right = left + 1;
                   let smallest = i;
                   if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
                   if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
                   if (smallest === i) break;
                   [items[smallest], items[i]] = [items[i], items[smallest]];
                   i = smallest;
               }
           }
           return top;
       }
   }