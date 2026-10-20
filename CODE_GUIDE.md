# Подробное руководство по коду

Проект — браузерный генератор пиксельных фэнтези-карт. Никаких готовых картинок и
библиотек: карта целиком вычисляется в коде и рисуется по пикселям.

Документ описывает архитектуру, модель данных и все типовые функции по секциям.
Актуален для ветки `master` (модуль фракций, менеджеры хода/экономики как данные).

---

## 1. Общая картина

### 1.1. Слои приложения

Код разделён на независимые уровни, каждый из которых ничего не знает о внутренностях
соседнего:

```
index.html          — разметка и кнопки интерфейса
  main.js           — «клей»: создаёт генератор и рендерер, вешает обработчики кнопок
    map-generator.js  — ЛОГИКА МИРА: рельеф, климат, ресурсы, реки, регионы, поселения, дороги
    seasons.js        — палитры сезонов (весна/лето/осень/зима) и тёмного стиля
    map-painter.js    — РЕНДЕР: превращает логическую карту в холст с пикселями
    map-renderer.js   — КАМЕРА: показывает нужный кусок холста, зум, выделение клетки
    sprite-renderer.js — объекты поверх карты (города, армии), рисуются по конфигу
    faction-manager.js — ФРАКЦИИ: территории, ресурсы, доход (отдельный от карты модуль)
```

Порядок подключения в `index.html` важен: `map-generator.js` → `seasons.js` →
`map-painter.js` → `sprite-renderer.js` → `sprite-examples.js` → `map-renderer.js` →
`faction-manager.js` → `main.js`. `faction-manager.js` берёт константы `Resource`,
`ResourceInfo`, `Terrain` из `map-generator.js`, поэтому идёт после него.

Ключевая идея производительности: **карта рисуется один раз** в большой скрытый холст
в масштабе 1:1 (`MapPainter`), а `MapRenderer` только показывает из него нужный
прямоугольник с зумом. Поэтому панорамирование и зум дешёвые, а перерисовка карты
происходит только при смене вида, сезона или стиля.

### 1.2. Поток данных

```
MapGenerator.generate(seed)
   → заполняет плоские массивы (terrain, biome, river, regionId, ...)
MapPainter.paint({ view, seasonName, showBorders, mood })
   → читает массивы и палитру сезона, пишет пиксели в ImageData, возвращает холст
MapRenderer
   → drawImage(холст) с учётом камеры, рисует сетку/границы/выделение/объекты поверх
FactionManager(map)
   → читает из карты регионы/ресурсы/население, передаёт состояние обратно в карту
     (map.applyFactionState), карта оповещает рендерер — слой фракций обновляется сам
```

Генератор и painter не вызывают друг друга напрямую: painter читает **только** поля
объекта карты. Это позволяет тестировать генерацию без DOM (см. раздел 10).

### 1.3. Принцип «только данные» у менеджеров

Ход, экономика и фракции — это **отдельные модули** (в текущем репозитории есть
`faction-manager.js`; ход и экономика заложены как API, их менеджеры подключаются так же).
Карта (`MapGenerator`) этими состояниями не управляет. Менеджер читает из карты данные и
передаёт обратно готовое состояние через `applyTurnState` / `applyEconomyState` /
`applyFactionState`. Карта его копирует, показывает в `getTileInfo` / `getRegionInfo` и
оповещает подписчиков (`onTurnState` / `onEconomyState` / `onFactionState`). Рендерер
подписывается на карту и перерисовывается сам, ничего не зная о менеджерах.

---

## 2. Модель данных `MapGenerator`

Вся карта — это плоские массивы длиной `size * size`. Клетка `(x, y)` имеет индекс
`i = y * size + x`. Обратное преобразование: `x = i % size`, `y = Math.floor(i / size)`.

Почему плоские типизированные массивы (`Float32Array`, `Uint8Array`): они компактны,
не создают мусор для сборщика и быстро читаются в горячих циклах.

### 2.1. Справочники (перечисления)

| Константа   | Значения                                                                 |
|-------------|--------------------------------------------------------------------------|
| `Terrain`   | `DEEP_WATER=0`, `SHALLOW_WATER=1`, `PLAIN=2`, `MOUNTAIN=3`                |
| `Biome`     | `TUNDRA=0`, `TAIGA=1`, `GRASSLAND=2`, `STEPPE=3`, `DESERT=4`, `SAVANNA=5` |
| `Shore`     | `NONE=0`, `BEACH=1`, `ROCKY=2`, `CLIFF=3`                                |
| `Resource`  | `NONE=0`, `WOOD=1`, `WHEAT=2`, `GOLD=3`, `ETHER=4`, `IRON=5`, `SETTLEMENT=6` |

`isLand(i)` — «суша ли это» — определяется как `terrain[i] >= Terrain.PLAIN`.

`ResourceInfo` — таблица «что даёт ресурс» (`name`, `produces`): её используют и
интерфейс, и `FactionManager.getFactionInfo` для подсчёта дохода.

`ROAD_DIRECTIONS` — 8 направлений дороги. Направление `d` и `7 - d` — противоположные
(это используется, чтобы восстановить связь между клетками по битовой маске `roadLinks`).

### 2.2. Основные поля после `generate()`

| Поле                | Тип            | Смысл                                                    |
|---------------------|----------------|----------------------------------------------------------|
| `elevation`         | `Float32Array` | высота (сырой шум + хребты)                              |
| `moisture`          | `Float32Array` | влажность 0..1 (выровнена по рангу)                      |
| `ridge`, `massif`   | `Float32Array` | «хребтовость» и «массивность» для гор                    |
| `temperature`       | `Float32Array` | температура 0..1 (север холодный)                        |
| `terrain`           | `Uint8Array`   | рельеф (`Terrain`)                                       |
| `biome`             | `Uint8Array`   | биом (`Biome`)                                           |
| `waterDepth`        | `Uint8Array`   | глубина воды = расстояние до суши                        |
| `river`             | `Uint8Array`   | 0 — нет реки, 1..3 — глубина                             |
| `riverTo`, `riverFlow` | `Int32Array` / `Uint16Array` | куда течёт река и сколько воды через клетку |
| `shore`             | `Uint8Array`   | тип берега (`Shore`)                                     |
| `crossing`          | `Uint8Array`   | 0/1 брод/2 мост                                          |
| `resource`          | `Uint8Array`   | ресурс (`Resource`)                                      |
| `mountainHeight`    | `Float32Array` | высота гор 0.3..1 (для рельефа painter'а)                |
| `regionId`          | `Int16Array`   | номер региона, -1 — вода/река/вне региона                |
| `regionSizes`       | `Object`       | id региона → число клеток                                |
| `landTiles`         | `Array`        | индексы всех клеток суши                                 |
| `population`, `settlementLevel`, `settlementGroup` | массивы | данные поселений |
| `settlements`, `settlementGroups` | `Array` | списки клеток и групп поселений           |
| `roadLevel`, `roadLinks` | `Uint8Array` | наезженность дороги и биты направлений             |
| `growth`            | `Float32Array` | степень роста леса/поля 0..1 (меняет экономика)          |

### 2.3. Поля состояния менеджеров

| Поле             | Тип            | Кто пишет            | Смысл                                      |
|------------------|----------------|----------------------|--------------------------------------------|
| `turnState`      | `Object`       | `applyTurnState`     | `{ turn, year, season, seasonIndex, turnInSeason, version }` |
| `economyVersion`, `visualVersion` | `Number` | `applyEconomyState` | версия экономики и «видимых» изменений |
| `factions`       | `Array`        | `applyFactionState`  | `[{ id, name, color, capitalRegion, capitalTile }]` |
| `tileFaction`    | `Int16Array`   | `applyFactionState`  | id фракции-владельца клетки, -1 — ничья    |
| `factionVersion` | `Number`       | `applyFactionState`  | версия состояния фракций (по ней перерисовывается слой) |

---

## 3. `map-generator.js`

### 3.1. Вспомогательные функции (в начале файла)

**`clamp(value, min=0, max=1)`** — ограничивает число диапазоном. Значения по умолчанию
(`0..1`) выбраны так, чтобы в большинстве мест вызывать просто `clamp(v)`.

**`growthStage(growth)`** — ступень роста (0..`GROWTH_STAGES`) для леса/поля. Ступени общие
для карты и отрисовки: перерисовывать нужно, только когда клетка перешла на другую ступень.

**`hash32(n)`** — быстрый хеш числа в диапазон `0..2^32`. Даёт «несвязанные» значения для
соседних номеров клеток. Простое умножение давало «решётчатые» узоры (реки бежали
параллельными полосами) — отсюда такой хеш.

**`lerp(a, b, t)`** — линейная интерполяция `a + (b - a) * t`.

**`createRandom(seed)`** — генератор псевдослучайных чисел (mulberry32). Возвращает функцию
`random()`. Ключевое свойство: **один seed даёт одну и ту же последовательность** — карта
воспроизводима. Тот же алгоритм продублирован в `faction-manager.js` (`factionRandom`), но с
независимым состоянием: расстановка фракций не зависит от порядка вызовов генератора карты.

**`rankNormalize(values)`** — выравнивает значения до равномерных `0..1` **по рангу**:
самое малое станет 0, самое большое — 1. Это позволяет порогам вида «нижние 40%» работать
честно, независимо от того, как шум «слипается» вокруг 0.5.

**`percentile(values, share)`** — значение на заданной доле отсортированного списка
(0.5 — медиана). Через него заданы `seaLevel`, `mountainLevel` и порог островов: доли воды и
гор не зависят от настроек шума.

### 3.2. Класс `ValueNoise`

Плавный шум 0..1: значения в соседних точках похожи. `lattice` — таблица 65×65 случайных
значений (решётка заворачивается по маске `& 63`).

- **`sample(x, y)`** — одна октава: билинейная интерполяция между четырьмя ближайшими узлами
  решётки со сглаживанием `t*t*(3-2*t)`.
- **`fractal(x, y, octaves)`** — сумма октав: крупные формы плюс всё более мелкие детали
  (амплитуда делится на 2, частота умножается на 2).

### 3.3. `MapGenerator.DEFAULTS` и `constructor`

`DEFAULTS` — один большой объект настроек, сгруппированный по разделам (суша и вода,
климат, ресурсы, редкие ресурсы, берега, поселения, дороги, реки и озёра, регионы).
Комментарии объясняют смысл и «за что отвечает» каждое число. Значения «по размеру карты»
(пороги рек, дальность дорог) заданы для карты 300×300 и пересчитываются по `size`.

`constructor` собирает `this.options = { ...DEFAULTS, ...options }`, запоминает `size` и
создаёт наборы подписчиков (`factionListeners`, `turnListeners`, `economyListeners`),
которые **переживают новую генерацию**.

### 3.4. `generate(seed)` — главный конвейер

```
createNoiseLayers → allocateLayers
  → generateElevation → scatterIslands → generateMoisture → classifyTerrain
  → removeSmallMountains → removeSmallIslands → collectLandTiles → fillDepressions
  → computeWaterDepth → generateTemperature → assignBiomes → placeResources
  → generateRivers → classifyShores → placeRareResources → placeRiverCrossings
  → buildRegions → placeSettlements → buildRoads → clearRoadResources → initGrowth
```

Порядок важен: реки строятся после рельефа (вода стекает по высотам), регионы — после рек
(река всегда граница и в регион не входит), поселения и дороги — после регионов.

- **`initGrowth()`** — леса и поля изначально «полностью выросли» (рост 1); дальше его меняет
  экономика.
- **`clearRoadResources()`** — на дорогах нет ресурсов (клетка расчищена), кроме поселений.

### 3.5. Шум и слои

- **`createNoiseLayers()`** — по одному `ValueNoise` на каждый аспект (высота, хребты,
  температура, влажность, скручивание, лес, плодородие, форма, впадины, острова, массивы,
  руда, разломы, берега, железо), каждый со своим сдвигом seed.
- **`allocateLayers()`** — создаёт все плоские массивы карты (см. таблицу 2.2) и заполняет
  их значениями по умолчанию (`regionId`, `riverTo`, `settlementGroup` — `-1` и т. п.).

### 3.6. Рельеф

- **`generateElevation()`** — высота = шум + падение к краям (мир окружён водой) + хребты +
  регулятор формы (заливы/полуострова) + внутренние моря. Координаты «скручиваются» шумом
  (`warp`), чтобы берега и хребты были извилистыми.
- **`scatterIslands()`** — в полосе мелководья отдельные «горбы» шума поднимает над уровнем
  моря (плотность задаёт `islandDensity`).
- **`generateMoisture()`** — шум влажности, выровненный `rankNormalize` до равномерных 0..1.

### 3.7. Вода / равнина / гора

- **`classifyTerrain()`** — считает `seaLevel` (доля воды) и `mountainLevel` по «оценке»
  клетки: `0.85·((1-clustering)·ridge + clustering·massif) + 0.15·height`. Горам задаётся
  `mountainHeight` (0.3..1) — по нему painter рисует рельеф.
- **`removeSmallMountains()`** — горы меньше `minMountainSize` превращает в равнину
  (BFS по 4 соседям).
- **`removeSmallIslands()`** — суша меньше `minIslandSize` становится водой (через
  `collectLandComponent`).
- **`collectComponent(start, accept, visited)`** — общий обход в ширину: все клетки, связанные
  с `start` (4 соседа), для которых `accept(i)` истинно. Порядок добавления сохраняется, поэтому
  результат детерминирован.
- **`collectLandComponent(start, visited)`** — все клетки суши, связанные с `start` (обёртка над
  `collectComponent` с `accept = i => isLand(i)`).
- **`collectLandTiles()`** — пересобирает `landTiles`.
- **`computeWaterDepth()`** — глубина = расстояние до ближайшей суши (BFS от всех клеток суши
  по 8 соседям); работает и для океана, и для озёр.
- **`neighbors(i)` / `neighbors8(i)`** — 4 и 8 соседей клетки внутри карты.

### 3.8. Климат и биомы

- **`generateTemperature()`** — север холодный, юг жаркий, плюс шум и охлаждение от высоты.
- **`assignBiomes()` / `pickBiome(t, m)`** — биом равнины по температуре и влажности
  (тундра / тайга / луг / степь / пустыня / саванна).

### 3.9. Ресурсы

- **`placeResources()`** — лес и поля: `createPatchLayer` даёт «пятна» (крупные скопления +
  мелкие кучки), затем случайный шанс дерева/пшеницы с учётом температуры и влажности.
- **`createPatchLayer(...)`** — бинарный слой «попадает ли клетка в скопление».
- **`createDensityLayer(noise, scale)`** — плавный шум, выровненный `rankNormalize`.
- **`tilesNearMountains(distance)`** — 1 для гор и суши не дальше `distance` клеток от гор
  (BFS).

### 3.10. Редкие ресурсы

- **`placeRareResources()`** → `placeGold` / `placeIron` / `placeEther`.
- **`placeGold` / `placeIron`** — в горах и предгорьях, скоплениями (`createDensityLayer`);
  золото не вытесняет железо, железо не перекрывает золото.
- **`placeEther`** — вдоль «линий разлома» (`createFaultLayer`: максимум там, где шум
  пересекает 0.5).

### 3.11. Берега

- **`classifyShores()`** — тип берега для суши у воды/рек: горы у воды — всегда утёсы; низкие
  тёплые берега пятнами становятся пляжами; остальное — каменистый берег.

### 3.12. Реки и озёра

Реки — часть рельефа, а не линии поверх карты.

- **`fillDepressions()`** — «заливка впадин» (priority-flood, `MinHeap`): из моря и краёв
  карты затопляет сушу от низких мест к высоким; у каждой клетки появляется сток `flowTo`, а
  впадины без стока становятся озёрами. Сохраняет `filled` и `flowTo`.
- **`isDiagonal(a, b)`** — соседи ли клетки по диагонали.
- **`generateRivers()`** — дождь на каждую клетку стекает по `flowTo`; где воды много — река,
  чем больше — тем шире (`river`, `riverFlow`, `riverTo`). Пороги заданы для карты 300×300.
- **`placeRiverCrossings()`** — на прямых участках рек изредка ставит мост (река глубже 1) или
  брод.

### 3.13. Регионы (самый большой раздел)

Регион — связный кусок суши **без рек** (и без моря с озёрами); реки остаются границами.
Строится как «диаграмма Вороного по стоимости пути» с релаксацией Ллойда.

- **`buildRegions()`** — раскладывает семена пропорционально площади, делит землю по стоимости
  пути, несколько раз «центрует» семена (`relaxRegionSeeds`), затем чинит обрывки, вливает
  мелочь, выравнивает размеры и сглаживает границы.
- **`shuffled(list)`** — перемешанная копия (свой RNG).
- **`buildRegionCosts()`** — цена «зайти» в клетку: единица + шум (неправильность границ) +
  горы (преграда).
- **`regionNeighbors(i)`** — соседи для роста региона (4 стороны + диагонали, но диагональ
  разрешена, только если обе клетки «за углом» годятся — регион не просачивается сквозь изгиб
  реки или берега). Возвращает плоский список `[клетка, длина шага, ...]`.
- **`regionAreas()`** — отдельные массивы региональной суши.
- **`pickRegionSeeds(area, count)`** — семена случайно, но не вплотную (зазор уменьшается),
  равнинам предпочтение; **`markSquare(blocked, i, radius)`** — блокирует квадрат вокруг семени.
- **`assignRegions(seeds)`** — Дейкстра от всех семян сразу (мультиисточник).
- **`relaxRegionSeeds(seeds)`** — новое семя = клетка региона, ближайшая к его центру тяжести.
- **`repairRegionConnectivity()`** — обрывки региона отдаёт соседу с самой длинной границей.
- **`bestNeighborRegion(tiles, ownId)`** / **`regionAcrossRiver(tiles, ownId)`** — сосед по
  границе / сосед на другом берегу реки.
- **`countRegionSizes()`**, **`mergeSmallRegions()`**, **`regionContacts(tile, id)`**,
  **`balanceRegionSizes()`** — выравнивание размеров: клетки перетекают от больших регионов к
  малым, не разрывая донора.
- **`smoothRegionBorders(minFactor, maxFactor)`** — сглаживание границ по 8 соседям.
- **`staysConnectedWithout(removed, id)`** — не расколется ли регион без клетки.
- **`renumberRegions()`** — номера регионов подряд (после слияний остаются дыры).

### 3.14. Поселения

Поселение — ресурс клетки (`Resource.SETTLEMENT`); оно даёт население и золото. Группы из
1–4 соседних клеток, у каждой клетки свой уровень 1–4 (число домиков в painter).

- **`placeSettlements()`** — население региона из «обитаемости» его клеток × случайный
  множитель; крупные группы ставятся первыми, большим регионам достаётся вторая группа.
- **`computeHabitability()`** — насколько клетка подходит для жизни (биом + влажность + река +
  берег − утёс).
- **`settlementLevelFor(population)`** — уровень клетки по населению (логарифмическая шкала).
- **`isSettlementSite(...)`**, **`growSettlementGroup(...)`**, **`commitSettlementGroup(...)`** —
  выбор места, рост группы вокруг центра, запись группы (деление населения, уровни, дорожки).

### 3.15. Дороги

- **`buildRoads()`** — K ближайших соседей каждого поселения (через бакеты по клеткам), рёбра
  по возрастанию длины: каркас (связываем несвязанное, как остовное дерево) + несколько петель.
- **`findRoadPath(start, goal)`** — A*; массивы поиска переиспользуются между вызовами
  (`searchCost` / `searchStamp` / `searchFrom` со «штампом прогона»).
- **`roadStepCost(...)`** — цена шага: вода и горы непроходимы, лес и подъёмы замедляют, руды и
  эфир дороги, готовые дороги дёшевы.
- **`carveRoad(path)`** — сохраняет уровень дороги, связи (`roadLinks`) и мосты через реки.

### 3.16. Ход, экономика, фракции (только данные)

- **`applyTurnState(state)` / `onTurnState(listener)`** — состояние хода и подписка на него.
- **`applyEconomyState({ growth, population, resourceChanges, version })`** — проверяет, что
  данные подходят к карте; меняет рост, население и лес/поле (только `NONE`/`WOOD`/`WHEAT`),
  пересчитывает производное (уровень поселения, население групп и регионов) и сообщает
  слушателям `{ visualChanged }` — стоит ли перерисовывать карту.
- **`applyFactionState({ factions, tileFaction, version })` / `onFactionState(listener)`** —
  принимает состояние фракций, копирует его и оповещает подписчиков.

### 3.17. Топология и сводки

- **`regionTileList(regionId)`** — клетки региона.
- **`regionGraph()`** — соседство регионов (общая граница или соседи через реку).
- **`getRegionInfo(regionId)`** — сводка по региону (размер, горы, реки, население, ресурсы,
  биомы, владельцы-фракции).
- **`getTileInfo(x, y)`** — сводка по клетке (для интерфейса).
- **`get landShare` / `get regionCount`** — статистика для подписи.

### 3.18. Класс `MinHeap`

Двоичная куча `push(cost, tile, region)` / `pop()`: достаёт самый «дешёвый» элемент. Нужна для
заливки впадин, роста регионов и поиска пути A*.

---

## 4. `seasons.js`

Палитры сезонов и тёмного стиля. Идея: приглушённые природные тона с тёплыми тенями, а сезоны
различаются не только цветом, но и тем, **как нарисована флора** (весна — цветущие деревья,
зима — голые лиственные и снег на елях).

- **`SEASONS`** — объект `{ spring, summer, autumn, winter }`, у каждого `name`, `tempShift`
  (сдвиг температуры, от него зависят снег и лёд) и `palette`.
- **Поля палитры**: `biome`, `rock`, `water` (5 оттенков), `ice`, `snow`/`snowShade`,
  `broadleaf`, `conifer`, `trunk`, `blossom`, `bareTrees`, `snowOnConifers`, `wheatStage`,
  `groundDetail`.
- **`toneHex(hex, {...})`** — приглушает/подсвечивает цвет; **`DARK_TONES`**, **`DARK_EXTRA`** —
  поправки тёмного стиля; **`DARK_SEASONS`** — производные палитры для тёмного стиля.

---

## 5. `map-painter.js`

### 5.1. Файловые константы и утилиты

- **`COLORS`** — цвета, не зависящие от сезона (hex); **`packRgb`** / **`hexToPacked`** —
  упаковка цвета в одно `Int32` (значение помещается в «маленькое целое», это быстрее, чем
  `Uint32`).
- **`mixPacked`** / **`shadeFast`** / **`shadePacked`** / **`speckColor`** — смешивание,
  затемнение и «крапинки» по упакованному цвету; **`hslToPacked`** — HSL в упакованный цвет.
- **`packPalette(palette)`** — заранее упаковывает всю палитру сезона (вызывается один раз на
  `paint`).
- **Константы** — `SNOW_TEMPERATURE`, `ICE_TEMPERATURE`, `RIVER_ICE_TEMPERATURE`,
  `WATER_DEPTH_STEPS` / `waterShadeIndex`, `STEP_AMOUNTS` (ступени светотени), `BAYER`
  (матрица дизеринга).
- **`tileHash(x, y, k)` / `hashUnit(x, y, k)`** — детерминированные «случайности»: не меняются
  при перерисовке. Соль `k` разводит разные детали.
- **`smoothstep(t)`**.
- **`computeHillShading(...)` / `applyHillShading(...)`** — светотень холмов считается один раз
  (горячий цикл вынесен в отдельную функцию), затем только применяется к пикселям.

### 5.2. Классы-помощники

- **`LatticeNoise(width, cell, salt)`** — плавный шум по пикселям: решётка и сглаженные позиции
  считаются один раз, потом `at(gx, gy)` берётся быстро.
- **`PixelBuffer`** — маленький пиксельный буфер для спрайтов (дом, руда, эфир): прозрачный фон,
  `put` / `rect` / `ellipse` / `outline`. Рисунок готовится один раз, потом копируется на карту.

### 5.3. `MapPainter` — конструктор и главный метод

- **`constructor(map, options)`** — настройки отрисовки (размер клетки, резкость смешивания,
  параметры гор, поселения, фракции, слои для отладки, тёмный стиль). `undefined` не затирает
  значения по умолчанию.
- **`paint({ view, seasonName, showBorders, mood })`** — главный метод: выбирает палитру,
  создаёт `ImageData`, вызывает слои по порядку (фон → сглаживание берега → рельеф/холмы/берега/
  реки/дороги/поселения → текстура → декорации → границы регионов → цветокоррекция → светящиеся
  детали), возвращает холст.
- **`layers`** — включение/отключение слоёв (режим разработки).

### 5.4. Пиксельные примитивы

**`px(n)`** (пиксели для клетки 12×12 → текущей), **`tileOfPixel(k)`** (индекс пикселя карты →
индекс клетки), **`put`** / **`blend`** / **`rect`** /
**`linePoints`** (Брезенхэм), **`forEachTile`**, **`seasonalTemperature(i)`**.

### 5.5. Фон

- **`paintBase()`** — цвет клетки «живёт» в её центре; пиксель выбирает один из четырёх
  ближайших цветов дизерингом. Быстрый путь: клетка и все соседи одного цвета — заливка целиком.
- **`blendGrid()`** / **`blendChoices(tx, ty)`** / **`buildAxisTables()`** / **`isUniform(...)`** —
  таблицы смешивания (предрассчитаны на каждую «резкость» и сдвиг узора).
- **`smoothCoast()`** — мажоритарный фильтр по маске воды скругляет ступенчатый берег.

### 5.6. Цвет клетки

**`buildTileColors()`**, **`isRiverTileInRegionsView(i)`**, **`tileColor(i)`**,
**`waterColor(i)`**, **`groundColor(i)`**, **`snowCoverage(i)`**, **`nearRiver(i)`**,
**`fertilityTint(i, color)`**, **`shadeStep(color, step)`**.

### 5.7. Холмы, берега, рельеф гор

- **`paintHills()`** / **`buildHillHeights()`** — светотень холмов и овраги.
- **`paintShores()`** / **`paintCliffs(queue, distance, kind)`** — пляжи, каменистые берега,
  утёсы.
- **`buildReliefHeights()`** / **`blurHeights(...)`** / **`prepareReliefRows()`** /
  **`paintReliefRow(...)`** / **`fillColumn(...)`** / **`blurMountainHeights()`** /
  **`mountainFootprint()`** / **`tilesNearRelief(blurred)`** / **`snowLevel(tile)`** — рельеф гор.

### 5.8. Реки и текстура

- **`paintRivers()`** / **`buildRiverGeometry()`** / **`paintBankPixel(...)`** /
  **`riverWidthAt`** / **`riverWidth`** / **`band`** — русла, берега, истоки.
- **`paintTexture()`** / **`speckLayout(...)`** / **`paintGroundDetail(...)`** /
  **`paintTufts(...)`** / **`putGround(...)`** — мелкая текстура земли, пучки травы.

### 5.9. Тёмный стиль

**`moodize(color)`**, **`applyGrading()`** (цветокоррекция, виньетка), **`buildFog()`**,
**`drawLight(...)`**, **`collectProps(items)`**, **`drawBones` / `drawCrow` / `drawRuin` /
`drawGibbet`** — мрачные детали только в тёмном стиле.

### 5.10. Дороги и поселения

- **`paintRoads()`** / **`buildRoadGeometry()`** / **`roadWidth(level)`** — дороги по
  `roadLinks`.
- **`settlementLayout(x, y, i)`** / **`layoutSettlement(...)`** / **`paintSettlementGround()`** /
  **`settlementGround(layout)`** / **`collectSettlement(...)`** — площадки под дома.
- **`houseColor`**, **`houseSprite(part, roll, snow)`**, **`drawHouse(...)`**,
  **`drawBuildingShadow(...)`**, **`blitSprite(...)`** — дома.

### 5.11. Руды, эфир, границы, сетка, фракции

- **`oreSprite` / `drawOreTile`**, **`etherSprite` / `drawEther`** — руды и эфирные кристаллы.
- **`buildPixelRegions()`** / **`computePixelRegions()`** / **`smoothPixelRegions(owner)`** /
  **`paintRegionBorders()`** / **`traceOutline(...)`** / **`regionOutline(regionId, smoothing)`** —
  пиксель наследует регион своей клетки, но берег скруглён и русла уже клетки: вода и реки
  ничьи, а клочки суши достаются ближайшему региону.
- **`buildCellMap()`** / **`cellAt(worldX, worldY)`** / **`cellOutline(tile, smoothing)`** /
  **`paintGrid()`** — карта «пиксель → клетка», контур ячейки и сетка.
- **`territoriesFromMap()`** / **`paintTerritories(territories)`** — слой территорий фракций:
  прозрачный холст с цветной границей и лёгкой заливкой. Граница идёт по реальной форме
  территории, вдоль берега и рек её нет.

### 5.12. Декорации

**`paintScene()`** / **`collectDecorations()`** / **`collectTrees(...)`** / **`drawShadow(...)`** /
**`drawBroadleaf` / `drawBareTree` / `drawConifer` / `drawWheat`** — деревья, поля, тени.
**`liftAtTile(...)`** / **`paintCrossing(...)`** / **`crossingDirections(...)`** — броды и мосты.

---

## 6. `map-renderer.js` — класс `MapRenderer`

Камера и взаимодействие. Карта рисуется в `MapPainter` один раз в холст 1:1 (`buffer`), камера
показывает нужный кусок с зумом.

- **`constructor`** — настройки (`tileSize`, зум, стиль, форма выделения, `autoRepaint`),
  создаёт `MapPainter`, подписывается на карту (`onFactionState` / `onTurnState` /
  `onEconomyState`) и вешает события.
- **`destroy()`** — отписка от карты.
- **`onTurnState` / `onEconomyState` / `scheduleRebuild()`** — собирает запросы на перерисовку:
  за один ход может поменяться и сезон, и рост лесов, а перерисуем один раз.
- **`refresh()` / `rebuildBuffer()`** — после новой генерации и при смене вида/сезона/стиля.
- **`setView` / `setSeason` / `setMood` / `setShowSettlements` / `setShowBorders` /
  `setShowGrid`** — переключатели.
- **Фракции**: `setShowFactions`, `setTerritories`, `refreshFactions`, `ensureFactionLayer` —
  слой строится лениво, по версии данных (`map.factionVersion` или `territoriesVersion`).
- **Объекты**: `setObjects`, `addObject`, `removeObject`, `objectBox`, `drawObjects`,
  `objectAt` — города/армии рисуются поверх карты на экране (их можно двигать без перерисовки).
- **Камера**: `get worldSize`, `fitToView`, `centerOn`, `clampCamera`, `panBy`, `zoomAt`,
  `screenToWorld`, `screenToTile`, `pickTile`.
- **Выделение**: `selectAt`, `clearSelection`, `regionOutline`, `regionShape`, `pathFromLoops`,
  `cellShape`, `roundedRectPath`, `drawSelection` — форма берётся из painter'а (точный контур).
- **`resize` / `draw` / `bindEvents` / `pointerToCanvas` / `reportHover`** — размер, отрисовка,
  ввод (мышь, колесо, клавиатура).

---

## 7. `faction-manager.js` — класс `FactionManager`

Отдельный от карты модуль: единственный владелец состояния фракций (кто чем владеет) и правил
(расстановка, захват, сводки, сохранение). Карта фракциями не управляет — менеджер читает из неё
данные и передаёт обратно готовое состояние через `map.applyFactionState`.

- **`factionRandom(seed)`** — свой mulberry32: расстановка не зависит от порядка вызовов
  генератора карты.
- **`FactionManager.DEFAULTS`** — стартовые фракции (`regions` — число или `[мин, макс]`),
  `seedDistance`, `attempts`, `coverageWeight`, `fairnessWeight`, `seed`.
- **`attach(map)`** — привязка (в т.ч. к заново сгенерированной карте): состояние сбрасывается
  и передаётся в карту.
- **`touch(reason)`** — состояние изменилось: версия +1, передача в карту, оповещение
  подписчиков.
- **`onChange(listener)`** — подписка на любые изменения.
- **`getState()` / `setState(state)`** — сохранение и восстановление (проверяет, что состояние
  от той же карты).
- **Управление**: `addFaction`, `claimTiles`, `releaseTiles`, `claimRegion`, `releaseRegion`,
  `assignTiles` (без оповещения — для пакетных изменений).
- **Чтение**: `factionAt`, `getFactionTiles`, `getFactionRegions`, `getFactionInfo` (территория,
  население, поселения, ресурсы, доход — `income` считается через `ResourceInfo`),
  `territories()`.
- **`regionCount(value, random)`** — сколько регионов у фракции.
- **`generate(definitions)`** — расставляет стартовые фракции: столицы на расстоянии
  `seedDistance` регионов, вокруг — компактная группа соседних регионов; из `attempts` раскладок
  берётся лучшая по размеру, разнообразию ресурсов и равенству населения сторон.
- **`capitalTileOf(regionId, tiles)`** — столица: центр самой населённой группы поселений, иначе
  клетка равнины ближе всего к середине региона.

---

## 8. `sprite-renderer.js` и `sprite-examples.js`

- **`SpriteRenderer`** — рисует объект (город, деревня, армию) по конфигу: `render(config,
  options)`, `resolveConfig`, слои (`drawLayer`, `rasterize`, `insidePolygon`, `linePoints`,
  `drawPixels`, `drawScatter`, `drawGradient`, `drawShadow`, `drawOutline`, `setPixel`,
  `toCanvas`). Спрайты кэшируются, размеры заданы для клетки 12×12.
- **`SPRITE_EXAMPLES`** — готовые конфиги (`city`, `village`, `army`) для демонстрации.

---

## 9. `main.js` и `index.html`

`main.js` — «клей»: создаёт `MapGenerator`, `MapRenderer`, `FactionManager`; описывает подписи
для интерфейса (`TERRAIN_NAMES`, `BIOME_NAMES`, `RESOURCE_NAMES`, `CROSSING_NAMES`,
`describeTile`, `describeRegion`, `showStats`); вешает обработчики кнопок (новая карта, вид,
сезон, стиль, сетка, границы, «вся карта», пример объектов) и выделение по клику.

`index.html` — разметка, стили, canvas `#map` и подключение скриптов в порядке зависимостей.

---

## 10. Типовые приёмы (паттерны)

- **Плоские массивы + `index(x, y)`**: вся карта в типизированных массивах.
- **Один seed → одна карта**: `createRandom`/`factionRandom` и `hash32`/`tileHash`; никакого
  `Math.random()` в генерации и отрисовке.
- **Секции-баннеры**: `SECTION: ИМЯ` внутри `/* ===== */` между крупными блоками файла и
  между группами методов класса; методы идут в порядке конвейера, не по алфавиту. Полный
  список имён — в разделе 12 «Карта секций».
- **Кэш-«гард»**: `const cache = this.XCache; if (cache && cache.source === ... && cache.key ===
  ...) return ...` — около десятка мест в painter'е (см. `OPTIMIZATION.md`, пункт 1).
- **«Только данные» у менеджеров**: состояние передаётся в карту, карта оповещает подписчиков.
- **Пиксель-детерминизм**: `hashUnit(x, y, salt)` вместо случайности, `BAYER` для дизеринга.

## 11. Как запустить и проверить

1. **Открыть** `index.html` в браузере (файлов хватает, сборки нет).
2. **Синтаксис**: `node --check map-generator.js && node --check map-painter.js && node --check
   faction-manager.js`.
3. **Генерация**: `new MapGenerator({ size: 120 }).generate(42)` в Node (загрузить
   `seasons.js` + `map-generator.js` как classic-скрипты) и сравнить массивы до/после правки.
4. **Отрисовка**: `MapPainter.paint(...)` на заглушечном canvas (`createImageData` /
   `putImageData`) для всех видов × сезонов × стилей и сравнить хэш пикселей.
5. **Тестер в браузере**: `map-test.html` прогоняет генерацию и отрисовку, считает хэши и
   сверяет с эталоном (см. `AGENTS.md`).

## 12. Карта секций

Все файлы размечены баннерами `SECTION: ИМЯ` внутри `/* ===== */`. Ниже — порядок секций
(он же порядок кода: секции идут по конвейеру, не по алфавиту). Имена в `map-painter.js` и
`map-generator.js` совпадают с `MapGeneratorReference.js` там, где смысл тот же.

### map-generator.js — данные карты

| Секция | Что внутри |
|---|---|
| `MAP_ENUMS` | `Terrain`, `Biome`, `Shore`, `Resource`, `ResourceInfo`, `ROAD_DIRECTIONS` |
| `MAP_UTILS` | `clamp`, `growthStage`, `hash32`, `lerp`, `createRandom`, `rankNormalize`, `percentile` |
| `MAP_NOISE` | класс `ValueNoise` (плавный шум 0..1) |
| `MAP_GENERATOR` | класс `MapGenerator` целиком |
| `GENERATE` | `generate()` — конвейер; `initGrowth`, `clearRoadResources`, `createNoiseLayers`, `allocateLayers` |
| `GRID` | `index`, `neighbors`, `isLand` — доступ к клеткам |
| `ELEVATION` | `generateElevation`, `scatterIslands`, `generateMoisture` |
| `TERRAIN` | `classifyTerrain`, `removeSmallMountains`, `removeSmallIslands`, `collectComponent`, `collectLandComponent`, `collectLandTiles`, `computeWaterDepth`, `neighbors8` |
| `CLIMATE` | `generateTemperature` |
| `BIOMES` | `assignBiomes`, `pickBiome` |
| `RESOURCES` | `placeResources`, `createPatchLayer`, `createDensityLayer` |
| `RARE_RESOURCES` | `placeRareResources`, `placeGold`, `placeIron`, `tilesNearMountains`, `placeEther`, `createFaultLayer` |
| `SHORES` | `classifyShores` |
| `RIVERS` | `fillDepressions`, `isDiagonal`, `generateRivers`, `placeRiverCrossings` |
| `REGIONS` | `buildRegions`, `shuffled`, `buildRegionCosts`, `regionNeighbors`, `regionAreas`, `pickRegionSeeds`, `markSquare`, `assignRegions`, `relaxRegionSeeds`, `repairRegionConnectivity`, `bestNeighborRegion`, `countRegionSizes`, `mergeSmallRegions`, `regionAcrossRiver`, `regionContacts`, `balanceRegionSizes`, `smoothRegionBorders`, `staysConnectedWithout`, `renumberRegions` |
| `SETTLEMENTS` | `placeSettlements`, `settlementLevelFor`, `isSettlementSite`, `growSettlementGroup`, `commitSettlementGroup`, `computeHabitability` |
| `ROADS` | `buildRoads`, `findRoadPath`, `roadStepCost`, `carveRoad` |
| `TURN_ECONOMY_STATE` | `applyTurnState`, `onTurnState`, `applyEconomyState`, `onEconomyState` |
| `FACTION_STATE` | `applyFactionState`, `onFactionState` |
| `REGION_TOPOLOGY` | `regionTileList`, `regionGraph` |
| `REGION_INFO` | `getRegionInfo` |
| `TILE_INFO` | `getTileInfo` |
| `MIN_HEAP` | класс `MinHeap` (нужен росту регионов) |

### map-painter.js — пиксельная отрисовка

| Секция | Что внутри |
|---|---|
| `MAP_COLORS` | `COLORS` — цвета, не зависящие от сезона |
| `MAP_PACKED_COLORS` | `packRgb`, `hexToPacked`, `hslToPacked`, `mixPacked`, `speckColor`, `shadeFast`, `shadePacked`, `MOUNTAIN_RAMP`, `packPalette` |
| `MAP_CONSTANTS` | `SNOW_TEMPERATURE`, `ICE_TEMPERATURE`, `WATER_DEPTH_STEPS`, `STEP_AMOUNTS`, `BAYER` |
| `MAP_HASH_NOISE` | `tileHash`, `hashUnit`, `smoothstep`, класс `LatticeNoise` |
| `MAP_SHADING` | `computeHillShading`, `applyHillShading` |
| `PIXEL_BUFFER` | класс `PixelBuffer` |
| `MAP_PAINTER` | класс `MapPainter` целиком |
| `PAINT` | `paint()` — порядок слоёв |
| `HELPERS` | `px`, `forEachTile`, `seasonalTemperature`, `put`, `blend`, `rect`, `linePoints` |
| `BACKGROUND` | `paintBase`, `blendGrid`, `blendChoices`, `buildAxisTables`, `isUniform`, `smoothCoast`, `buildTileColors`, `isRiverTileInRegionsView`, `tileColor`, `waterColor`, `groundColor`, `snowCoverage`, `nearRiver`, `fertilityTint`, `shadeStep` |
| `HILLS` | `paintHills`, `buildHillHeights` |
| `SHORES` | `paintShores`, `paintCliffs` |
| `MOUNTAIN_RELIEF` | `buildReliefHeights`, `blurHeights`, `prepareReliefRows`, `paintReliefRow`, `fillColumn`, `blurMountainHeights`, `mountainFootprint`, `tilesNearRelief`, `snowLevel` |
| `RIVERS` | `riverWidthAt`, `riverWidth`, `band`, `paintRivers`, `buildRiverGeometry`, `paintBankPixel` |
| `TEXTURE` | `paintTexture`, `speckLayout`, `paintGroundDetail`, `paintTufts`, `putGround` |
| `DARK_STYLE` | `moodize`, `applyGrading`, `buildFog`, `drawLight` |
| `DARK_PROPS` | `collectProps`, `drawBones`, `drawCrow`, `drawRuin`, `drawGibbet` |
| `ROADS` | `roadWidth`, `paintRoads`, `buildRoadGeometry` |
| `SETTLEMENTS` | `settlementLayout`, `layoutSettlement`, `tryPlace`, `paintSettlementGround`, `settlementGround`, `collectSettlement`, `houseColor`, `houseSprite`, `drawHouse`, `drawBuildingShadow`, `blitSprite` |
| `ORE` | `oreSprite`, `drawOreTile` |
| `ETHER` | `etherSprite`, `drawEther` |
| `REGION_BORDERS` | `buildPixelRegions`, `computePixelRegions`, `smoothPixelRegions`, `paintRegionBorders` |
| `OUTLINES_GRID` | `traceOutline`, `regionOutline`, `buildCellMap`, `cellAt`, `cellOutline`, `paintGrid` |
| `FACTIONS` | `territoriesFromMap`, `paintTerritories` |
| `DECORATIONS` | `paintScene`, `collectDecorations`, `collectTrees`, `drawShadow`, `drawBroadleaf`, `drawBareTree`, `drawConifer`, `drawWheat`, `liftAtTile`, `paintCrossing`, `crossingDirections` |

### Остальные файлы

| Файл | Секции |
|---|---|
| `seasons.js` | `SEASONS` (палитры + `SEASON_ORDER`), `DARK_SEASONS` (тёмный стиль, `toneHex`, `DARK_TONES`, `DARK_EXTRA`) |
| `map-renderer.js` | `MAP_RENDERER`, `PUBLIC`, `FACTIONS`, `OBJECTS`, `CAMERA`, `SELECTION`, `RENDER`, `INPUT` |
| `faction-manager.js` | `FACTION_MANAGER`, `STATE`, `CONTROL`, `READ`, `START_FACTIONS` |
| `economy-manager.js` | `ECONOMY_MANAGER`, `STATE`, `STEP`, `READ`, `SAVE`, `PLACEHOLDER` |
| `turn-manager.js` | `TURN_MANAGER`, `CALENDAR`, `PHASES`, `TURN`, `SAVE` |
| `main.js` | `MAIN`, `MANAGERS`, `NAMES`, `TURNS`, `ACTIONS`, `FACTIONS`, `SELECTION`, `BUTTONS`, `DEMO_OBJECTS` |
| `sprite-renderer.js` | `SPRITE_RENDERER`, `CONFIG`, `COLORS`, `LAYERS`, `OUTPUT` |
| `sprite-examples.js` | `SPRITE_EXAMPLES` |

Проверить разметку: `grep -n "SECTION:" *.js`.
