/* ============================================================
   MapPainter — ядро: настройки, порядок слоёв, общие инструменты рисования.
   Сами слои — в миксинах (painter-*.js), они регистрируются в MapPaint.mixins и ставятся в класс внизу этого файла.
   ============================================================ */
class MapPainter {
    constructor(map, options = {}) {
        this.map = map;
        this.options = {
            tileSize: 16,
            blendSharpness: 1.5,   // насколько резко смешиваются соседние биомы (больше — резче, 1 — очень мягко)
            coastSharpness: 1.5,   // то же для границы воды и суши — а также для берегов (песок, галька) и краёв рек
            peakSharpness: 0.85,   // 0..1: острота гор (0 — округлые холмы-«губка», 1 — острые пики и гребни)
            mountainLift: 14,      // на сколько пикселей (для клетки 12×12) самые высокие горы поднимаются вверх, к северу
            mountainDetail: 0.3,  // 0..1: мелкие грани и отроги на горах (0 — крупные чистые плоскости, 1 — много мелкого шума)
            mountainRagged: 0.34,  // 0..1: рваность кромки гор у подножия (0 — ровный край по клеткам, больше — «осыпь» и зубцы)
            mountainLight: 'left', // откуда падает свет на горы: 'left' (как у деревьев и холмов) или 'right' (как на референсе)
            hillStrength: 0.6,     // 0..1: заметность холмов и впадин на равнинах (0 — выключить)
            ravineDensity: 0.2,    // 0..1: сколько оврагов в сухих местах (0 — нет)
            grassDensity: 1,       // густота пучков травы (множитель)
            shores: true,          // пляжи, каменистые берега и утёсы
            settlements: true,     // поселения (домики)
            roads: true,           // дороги между поселениями
            settlementMinHouses: 1, // домиков в самом маленьком поселении
            settlementMaxHouses: 3, // домиков в клетке высшего уровня (если они помещаются)
            settlementOverflow: 0.25, // на сколько (доля клетки) основание дома может выйти за границу своей клетки
            coastSmoothing: 7,     // радиус (в пикселях) сглаживания берега: больше — круглее; 0 — не сглаживать
            riverTails: true,      // истончающиеся декоративные концы у истоков рек (река постепенно сходит на нет)
            factionBorder: 2,      // толщина цветной границы фракции в пикселях (для клетки 16×16; масштабируется вместе с клеткой)
            factionBorderOpacity: 0.75,
            factionFill: 0.2,      // лёгкая заливка земель фракции цветом фракции (0 — без заливки)
            factionCoastBorder: true,  // граница фракции идёт и вдоль берега моря и озёр
            factionRiverBorder: 'boundary', // вдоль берегов рек: 'always' — всегда (река в территорию не входит), 'boundary' — только если на том берегу другая территория
            regionShoreBorder: false,   // граница региона идёт и вдоль берега моря, озёр и рек (реки в регионы не входят)
            gridOpacity: 0.15,     // насколько заметна сетка клеток (0..1)
            regionBorderSmoothing: 7, // радиус (в пикселях) сглаживания углов границ регионов: больше — круглее; 0 — не сглаживать
            layers: {},            // режим разработки: { relief: false, hills: false, ... } отключает слои (см. paint)
            spriteOutline: false,  // тёмный контур вокруг построек, руд и эфира (в стиле dark fantasy выключен)
            grade: true,           // в тёмном стиле: цветокоррекция, туман, виньетка
            vignette: 0.35,        // затемнение к краям карты в тёмном стиле (0 — нет)
            props: true,           // в тёмном стиле: кости, вороны, развалины, виселицы
            ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) // undefined не должен затирать значения по умолчанию
        };
        this.tileSize = this.options.tileSize;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');

        this.caches = {};                                         // кэши, не зависящие от сезона (см. memo)
        this.colors = {};
        for (const [name, hex] of Object.entries(COLORS)) this.colors[name] = hexToPacked(hex);
    }

    // view: 'terrain' | 'temperature' | 'regions'. Возвращает холст с готовой картой.
    paint({ view, seasonName, showBorders, mood }) {
        this.view = view;
        this.mood = mood === 'dark' ? 'dark' : 'light';
        this.season = (this.mood === 'dark' ? DARK_SEASONS : SEASONS)[seasonName];
        this.pal = this.season.palette;
        this.packed = packPalette(this.pal);
        this.seedSalt = ((this.map.seed | 0) * 13) % 100000; // у каждой карты свои узоры шума

        this.width = this.map.size * this.tileSize;
        this.dim = { size: this.map.size, T: this.tileSize, W: this.width };   // сторона карты в клетках, клетка и карта в пикселях
        this.canvas.width = this.width;
        this.canvas.height = this.width;
        const image = this.ctx.createImageData(this.width, this.width);
        this.pixels = new Int32Array(image.data.buffer); // Int32: значения помещаются в «маленькие целые», это заметно быстрее, чем Uint32
        this.waterMask = new Uint8Array(this.width * this.width); // 1 — пиксель воды (заполняется при рисовании фона)
        this.spriteMask = new Uint8Array(this.width * this.width); // 1 — пиксель закрыт деревом, домом, рудой и т. п.: слои фракций и сетки под ними не видны
        this.cover = false;                                       // пока true, всё, что рисует put(), попадает в spriteMask
        this.riverMask = null;
        this.relief = null;
        this.reliefHeight = null;
        this.emissive = [];   // источники света (окна, костры, эфирные разломы): рисуются после цветокоррекции, чтобы оставаться яркими
        this.buildAxisTables();

        // Слои можно отключать (опция layers) — для быстрой разработки: например, смотреть только горы без леса, дорог и тумана.
        const layers = { relief: true, hills: true, shores: true, rivers: true, roads: true, settlements: true, texture: true,
            borders: true, decorations: true, grading: true, ...this.options.layers };
        this.layers = layers;

        const terrain = view === 'terrain';
        this.paintBase();
        this.smoothCoast();
        if (terrain) {
            if (layers.relief) {
                this.relief = this.buildReliefHeights();
                this.reliefHeight = this.relief.height;
            }
            for (const [layer, paintLayer] of MapPaint.GROUND_LAYERS) if (layers[layer]) this[paintLayer]();
        }
        if (layers.texture) this.paintTexture();
        if (showBorders && layers.borders) this.paintRegionBorders();
        if (terrain && (layers.decorations || layers.relief)) this.paintScene();

        if (terrain && this.mood === 'dark' && this.options.grade && layers.grading) this.applyGrading();
        this.cover = true;                              // светящиеся детали (окна, костры, эфир) — тоже над землёй
        for (const draw of this.emissive) draw();
        this.cover = false;

        this.ctx.putImageData(image, 0, 0);
        return this.canvas;
    }
}

for (const mixin of MapPaint.mixins) Object.defineProperties(MapPainter.prototype, Object.getOwnPropertyDescriptors(mixin));
