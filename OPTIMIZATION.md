# Оптимизация: как убрать повторы и похожие фрагменты

Документ описывает конкретные места, где один и тот же (или почти один и тот же) код
повторяется, и предлагает, как это вынести. Предложения отсортированы по отношению
«польза / риск»: сначала то, что даёт много и почти не меняет поведение, потом более крупные
переделки.

Документ пересмотрен под ветку `master` (модуль фракций, состояние хода/экономики как данные).

Правило при любом таком рефакторинге: **сравнивать результат до и после**. Генерация и
отрисовка детерминированы по seed, поэтому достаточно сохранить карту/холст до правки и
сравнить байт-в-байт (см. раздел «Как проверять»).

---

## Сводка: что где повторяется

| # | Повтор | Где | Сколько раз | Польза | Риск |
|---|--------|-----|-------------|--------|------|
| 1 | Кэш-«гард»: `const cache = this.XCache; if (cache && cache.source === ... ) return ...` | map-painter | 12 | высокая | низкий |
| 2 | Преамбула `const T/W/size = ...` в каждом методе | map-painter | 34 / 29 / 11 | средняя | низкий |
| 3 | Ленивая инициализация + `get/set` | map-painter | 4 | средняя | низкий |
| 4 | Обход пикселей клетки `x0/y0 + два цикла` | map-painter | 3–4 | средняя | низкий |
| 5 | Обход 8 соседей вручную `for dy for dx` | оба файла | 7 | средняя | низкий |
| 6 | Разделяемое размытие (box blur) — две реализации | map-painter | 2 | средняя | средний |
| 7 | Заливка `flood fill` (BFS + visited) | map-generator, faction-manager | 10 | средняя | низкий |
| 8 | Ключ кэша `[...].join('|')` | map-painter | 5 | низкая | низкий |
| 9 | `this.px(n)` вызывается в горячих циклах по пикселям | map-painter | 61 | средняя (скорость) | низкий |
| 10 | Кнопки-переключатели в интерфейсе (`aria-pressed`) | main.js | 4 группы | низкая | низкий |
| 11 | «Магические» соли `hashUnit(x, y, N)` | map-painter | 29 | низкая | низкий |
| 12 | Локальные `tileOf` (пиксель → клетка) | map-painter | 2 | низкая | низкий |
| 13 | Декодирование координат клетки `i % size` / `Math.floor(i / size)` | map-generator, faction-manager | ~20 | низкая | низкий |
| 14 | Дублирующие `territories` / `territoriesFromMap` | map-painter, faction-manager | 2 | низкая | низкий |
| 15 | Две копии mulberry32 (`createRandom`, `factionRandom`) | map-generator, faction-manager | 2 | низкая | средний |
| 16 | `regionTileList` и его инлайн-копия в `getRegionInfo` | map-generator | 2 | низкая | низкий |

Ниже — по каждому пункту: что именно повторяется и как вынести.

---

## 1. Кэш-«гард» (самый заметный повтор)

### Что повторяется

Один и тот же приём — «если входные данные и ключ те же, вернуть готовое» — написан вручную
двенадцать раз, каждый раз чуть по-разному:

```js
// smoothCoast()
const key = [this.tileSize, radius, this.options.blendSharpness, this.options.coastSharpness, this.seedSalt].join('|');
const cache = this.coastCache;
if (cache && cache.source === this.map.terrain && cache.key === key) { /* переиспользовать */ }

// buildHillHeights()
const cache = this.hillCache;
if (cache && cache.source === map.elevation && cache.tileSize === this.tileSize) return cache.height;

// buildReliefHeights()
const cache = this.reliefCache;
if (cache && cache.source === map.mountainHeight && cache.tileSize === this.tileSize
    && cache.sharpness === sharp && cache.detail === detail && cache.ragged === ragged) return cache;

// buildRiverGeometry()
const key = [this.tileSize, this.options.coastSharpness, ...].join('|');
const cache = this.riverCache;
if (cache && cache.source === map.river && cache.key === key) return cache;

// paintHills(), buildRoadGeometry(), buildFog(), speckLayout(), buildPixelRegions(),
// buildCellMap(), nearRiver() — то же самое
```

Проблема не только в объёме: условия проверяются по-разному (где-то `key`, где-то набор
полей), и легко забыть одно поле — тогда кэш «залипнет» на устаревших данных. Это как раз
класс ошибок, который трудно заметить.

### Предложение

Один маленький помощник «запомнить результат по набору входов»:

```js
// Вспомогательное: кэш одной записи, который сам понимает, когда входы изменились.
function memoized(target, slot, inputs, build) {
    const cache = target[slot];
    if (cache && inputs.every((value, i) => cache.inputs[i] === value)) return cache.value;
    const value = build();
    target[slot] = { inputs: [...inputs], value };
    return value;
}
```

Использование:

```js
buildHillHeights() {
    return memoized(this, 'hillCache', [this.map.elevation, this.tileSize],
        () => this.computeHillHeights());
}
```

Плюсы: условие проверки в одном месте, набор входов виден списком, невозможно «забыть поле».
`source`/`key`/`salt` перестают быть особым случаем. Для кэшей, которые сейчас хранят
дополнительные поля (например, `riverCache` отдаёт `{ mask, queue, distance, ... }`),
помощник просто оборачивает объект целиком — вызывающий код не меняется.

Если менять сигнатуры не хочется, минимальный вариант — оставить ручные проверки, но свести
ключ к одному списку и одной функции `sameInputs(a, b)`, чтобы правило было единым.

---

## 2. Преамбула `const T / W / size`

### Что повторяется

Почти каждый метод painter'а начинается одинаково:

```js
const size = this.map.size;
const T = this.tileSize;
const W = this.width;
const pixels = this.pixels;
```

`const T = this.tileSize` — 34 раза, `const W = this.width` — 29, `const size = ...` — 11.
Это не ошибка, но это шум, из-за которого метод труднее читать, и дублирование, из-за
которого легко рассинхронизировать имена (`W` в одном методе, `width` в другом).

### Предложение

Свойство-геттер с «размерами» карты:

```js
get dims() {
    return { size: this.map.size, tile: this.tileSize, width: this.width };
}
```

и в начале метода:

```js
const { size, tile: T, width: W } = this.dims;
```

Это не ускоряет код (объект создаётся на вызов), но убирает повтор и делает одинаковые имена
во всех методах. Для самых горячих методов (внутренние циклы по миллионам пикселей)
достаточно оставить как есть — там важнее локальные переменные.

---

## 3. Ленивая инициализация

### Что повторяется

Несколько раз встречается приём «посчитать один раз и запомнить в поле объекта»:
`this.grid` (`blendGrid`), `this.axis` (`buildAxisTables`), `this.colors`/`this.packed`
(палитры), кэши поиска A* (`searchCost`/`searchStamp`/`searchFrom`).

### Предложение

Тот же `memoized` из пункта 1 покрывает случаи, где есть входы для сравнения. Где входов нет
(чистая ленивая инициализация) — оставить как есть: `if (this.grid) return this.grid;` читается
проще, чем универсальный помощник.

---

## 4. Обход пикселей клетки

### Что повторяется

«Для каждого пикселя клетки (tx, ty)» пишется вручную в `paintBase`, `paintShores`,
`paintTerritories` и т. п.:

```js
for (let oy = 0; oy < T; oy++) {
    for (let ox = 0; ox < T; ox++) {
        const k = (ty * T + oy) * W + tx * T + ox;
        // ...
    }
}
```

### Предложение

Небольшой помощник-итератор для тех мест, где он не мешает горячему циклу:

```js
// Индексы пикселей клетки (tx, ty) по строкам.
forTilePixels(tx, ty, visit) {
    const { tile: T, width: W } = this.dims;
    for (let oy = 0; oy < T; oy++) {
        const row = (ty * T + oy) * W + tx * T;
        for (let ox = 0; ox < T; ox++) visit(row + ox, ox, oy);
    }
}
```

В `paintBase` (самый горячий) лучше оставить развёрнутые циклы: вызов функции на каждый
пиксель дороже. Помощник уместен в слоях, где на клетку приходится немного работы.

---

## 5. Обход 8 соседей

### Что повторяется

Ручной двойной цикл `for dy for dx` с проверками границ встречается 7 раз: `neighbors8`,
`regionNeighbors`, `markBlocked`, `computeHabitability`-окрестности, `paintTerritories`,
`crossingDirections` и др.

### Предложение

В `MapGenerator` уже есть `neighbors8(i)`. В painter'е — вынести общий обход в один метод
(например, `forNeighbors8(tile, visit)`), где сейчас цикл написан руками. Для «блокировки
окрестности радиусом r» (`markBlocked`, `commitSettlementGroup`) — общий `markSquare(blocked,
tile, radius)`.

---

## 6. Две реализации размытия

### Что повторяется

Размытие (box blur) реализовано дважды: в рельефе гор (`blurHeights`) и в сглаживании границ
регионов/берегов. Оба проходят окно, считают сумму и делят на число элементов.

### Предложение

Одна функция размытия `boxBlur(field, width, radius, mask)` (с необязательной маской), которой
пользуются оба места. Риск средний (затрагивает вид карты), делать отдельным шагом с проверкой
хэша отрисовки.

---

## 7. Заливка `flood fill` / BFS

### Что повторяется

Цикл «обойти связную компоненту» (`queue[head]` + `visited`) написан **десять** раз:
`removeSmallMountains`, `collectLandComponent`, `computeWaterDepth`, `tilesNearMountains`,
`fillDepressions` (озёра), `regionAreas`, `repairRegionConnectivity`, `staysConnectedWithout`,
плюс два обхода в `faction-manager.js` (`generate`).

### Предложение

Один общий обход «связной компоненты»:

```js
// Все клетки, связанные с start, для которых accept(i) истинно. visited — общий массив (или создаётся).
collectComponent(start, accept, visited = new Uint8Array(this.terrain.length), neighbors = this.neighbors) {
    const queue = [start];
    visited[start] = 1;
    for (let head = 0; head < queue.length; head++) {
        for (const n of neighbors(queue[head])) {
            if (visited[n] || !accept(n)) continue;
            visited[n] = 1;
            queue.push(n);
        }
    }
    return queue;
}
```

`removeSmallMountains` → `accept = i => terrain[i] === MOUNTAIN`,
`removeSmallIslands` → `accept = i => isLand(i)`. Один BFS вместо нескольких.

Важно: у каждого места сейчас свой порядок обхода и свои критерии — при выносе нужно
сохранить порядок добавления в очередь, иначе результат может отличаться. Поэтому каждый
вынос — отдельная правка с проверкой генерации.

---

## 8. Ключ кэша `[...].join('|')`

Мелочь, но встречается 5 раз и легко ошибиться (забыть поле → устаревший кэш). Если
использовать помощник `memoized` из пункта 1, эта строка исчезает совсем — список входов
задаётся массивом и сравнивается поэлементно.

---

## 9. `this.px(n)` в горячих циклах (скорость)

### Что происходит

`px(n)` — это `Math.round(n * this.tileSize / 12)`. Вызовов `this.px(...)` в файле — 61.
Вызов метода на каждый пиксель/деталь дороже, чем умножение на заранее посчитанный множитель.
В спрайтах (руда, эфир, дома) `px` вызывается десятки раз на спрайт — но спрайты кэшируются,
так что это не горячее место. По-настоящему горячие — циклы по миллионам пикселей (`paintBase`,
рельеф, реки), но там `px` почти не вызывается.

### Предложение

Если профиль покажет, что спрайты или `paintShores` тормозят, посчитать множитель один раз
в начале метода:

```js
const scale = this.tileSize / 12;   // вместо px(n) внутри цикла
const unit = n => Math.max(1, Math.round(n * scale));
```

Это микрооптимизация; делать её стоит только по результатам измерений, иначе это усложнение
без пользы. Сначала измерить, потом трогать.

---

## 10. Кнопки-переключатели в `main.js`

### Что повторяется

Три раза описан один и тот же приём «переключить состояние кнопки `aria-pressed`»:

```js
const on = button.getAttribute('aria-pressed') !== 'true';
button.setAttribute('aria-pressed', on);
// ... применить ...
```

плюс две группы взаимоисключающих кнопок (сезоны и виды), где снимается нажатие с остальных.

### Предложение

Один помощник для группы взаимоисключающих кнопок:

```js
function bindRadioGroup(selector, apply) {
    const buttons = document.querySelectorAll(selector);
    buttons.forEach(button => button.addEventListener('click', () => {
        buttons.forEach(other => other.setAttribute('aria-pressed', other === button));
        apply(button.dataset.season ?? button.dataset.view);
    }));
}

bindRadioGroup('[data-season]', value => renderer.setSeason(value));
bindRadioGroup('[data-view]', value => renderer.setView(value));
```

Функция `toggleButton` уже есть — её достаточно для кнопок-флагов. Для групп появляется одна
общая функция вместо двух похожих блоков.

---

## 11. «Магические» соли `hashUnit(x, y, N)`

В painter'е `hashUnit(x, y, N)` вызывается 29 раз с разными числами-солями
(`977`, `980`, `981`, ...). Само по себе это нормальный приём (разные узоры для разных
деталей), но числа безымянные: непонятно, какая деталь какой число использует, и легко
случайно повторить соль (тогда две детали совпадут).

### Предложение

Именованная таблица:

```js
const SALT = {
    roadWobbleX: 980, roadWobbleY: 981,
    treePlacement: 977,
    // ...
};
```

Тогда `hashUnit(x, y, SALT.roadWobbleX)` — видно, что за деталь, и повтор соли заметен.
Низкий риск, делается по мере правок соседнего кода.

---

## 12. Локальные `tileOf` (пиксель → клетка)

В painter'е дважды объявлена почти одна и та же функция «индекс пикселя → индекс клетки»:

```js
// paintShores()
const tileOf = k => Math.floor(k / W / T) * size + Math.floor((k % W) / T);
// paintRivers()
const tileOf = k => Math.floor(Math.floor(k / W) / T) * size + Math.floor((k % W) / T);
```

Проверено: обе дают **одинаковый** результат на всех пикселях (разница только в записи
`k / W / T` против `Math.floor(k / W) / T`, а `k` и `W` целые). Предложение — один метод
`MapPainter.tileOfPixel(k)`.

---

## 13. Декодирование координат клетки

`const x = i % size; const y = Math.floor(i / size);` встречается ~20 раз (в генераторе, painter'е
и `faction-manager.js`). В генераторе есть `index(x, y)`, но обратной функции нет.

### Предложение

Пара методов `MapGenerator.tileX(i)` / `tileY(i)` (или один `coords(i)`), и такой же помощник в
painter'е. Выигрыш небольшой, но убирает шум и опечатки вида `Math.floor(i / size)` при
неверном имени переменной.

---

## 14. Дублирующие `territories`

`MapPainter.territoriesFromMap()` и `FactionManager.territories()` собирают одно и то же:
`map.factions` + `map.tileFaction` → `[{ id, color, tiles }]`. Достаточно оставить один
источник (например, `FactionManager.territories()`, а painter вызывает `map.factions` напрямую,
как в `territoriesFromMap`). Низкий риск.

---

## 15. Две копии mulberry32

`createRandom` (map-generator) и `factionRandom` (faction-manager) — один и тот же алгоритм.
Проверено: последовательности **совпадают** для одних и тех же seed (разница только в
знаковости сдвига, на результат не влияет). Держать две копии осознанно: так расстановка
фракций не зависит от порядка вызовов генератора карты.

### Предложение

Если хочется убрать копию — вынести mulberry32 в общий файл и **вызывать с независимым
состоянием** (создавать отдельный экземпляр на фракции). Тогда поведение сохранится, а
дублирование уйдёт. Риск средний (легко случайно «связать» два генератора) — делать
аккуратно, с проверкой хэша фракций.

---

## 16. `regionTileList` и его копия

`regionTileList(regionId)` — это `landTiles.filter(i => regionId[i] === regionId)`, и ровно то же
выражение продублировано в `getRegionInfo`. Заменить в `getRegionInfo` на вызов
`regionTileList`. Низкий риск.

---

## Что уже сделано

В текущей ветке `master` сделаны безопасные (поведение не менялось — проверено сравнением
хэшей генерации и отрисовки байт-в-байт, см. ниже):

1. **Общий обход `collectComponent(start, accept, visited)`** (пункт 7): в него сведены
   `removeSmallMountains` и `collectLandComponent`; `collectLandComponent` теперь тонкая
   обёртка над ним.
2. **`markSquare(blocked, i, radius)`** (пункт 5): бывший `markBlocked` — общее имя для
   «пометить квадрат вокруг клетки».
3. **`MapPainter.tileOfPixel(k)`** (пункт 12): три локальные копии `tileOf` заменены на один
   метод (проверено, что обе версии записи дают одинаковый результат).
4. **`getRegionInfo`** (пункт 16): использует `regionTileList` вместо своей копии фильтра.

В прошлой сессии (ветка с документацией) были проставлены секции-баннеры и убраны копии
`tileOf`/`pxMin`; в текущем `master` код генератора и painter'а переписан заново и появился
`faction-manager.js`, поэтому баннеры и часть пунктов (1, 2, 13) снова актуальны.

---

## Как проверять, что рефакторинг ничего не сломал

1. **Синтаксис**: `node --check map-generator.js && node --check map-painter.js &&
   node --check faction-manager.js`.
2. **Генерация**: `new MapGenerator({ size: 120 }).generate(42)` до и после правки, сравнить
   результат (сериализовать нужные массивы или хэш).
3. **Отрисовка**: `MapPainter.paint(...)` на заглушечном canvas (достаточно
   `createImageData`/`putImageData`) для всех видов × сезонов × стилей, сравнить хэш пикселей.
4. **Тестер**: `map-test.html` в браузере — прогоняет генерацию и отрисовку, считает хэши и
   сверяет с эталоном.

Если всё совпадает со «старым» результатом — рефакторинг чистый.

---

## Порядок работ (рекомендация)

1. Пункт 1 (`memoized`) — самое большое сокращение и самый понятный эффект.
2. Пункты 3 и 5 (ленивая инициализация, общие соседи) — механические, низкий риск.
3. Пункт 7 (общий BFS) — затрагивает логику регионов и рек: делать по одному месту, с
   проверкой генерации после каждого.
4. Пункт 2 (преамбула), 8 (ключи), 12–14, 16 — по мере касания соседнего кода.
5. Пункт 6 (общее размытие), 9 (микрооптимизация) и 15 (RNG) — только под измерением/отдельным
   шагом.

Не стоит делать всё сразу: каждый пункт — отдельная правка с отдельной проверкой. Так
«сломанный» шаг легко откатить, не теряя остальные улучшения.
