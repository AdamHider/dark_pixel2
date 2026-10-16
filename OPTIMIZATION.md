# Оптимизация: как убрать повторы и похожие фрагменты

Документ описывает конкретные места, где один и тот же (или почти один и тот же) код
повторяется, и предлагает, как это вынести. Предложения отсортированы по отношению
«польза / риск»: сначала то, что даёт много и почти не меняет поведение, потом более крупные
переделки.

Правило при любом таком рефакторинге: **сравнивать результат до и после**. Генерация и
отрисовка детерминированы по seed, поэтому достаточно сохранить карту/холст до правки и
сравнить байт-в-байт (см. раздел «Как проверять»).

---

## Сводка: что где повторяется

| # | Повтор | Где | Сколько раз | Польза | Риск |
|---|--------|-----|-------------|--------|------|
| 1 | Кэш-«гард»: `const cache = this.XCache; if (cache && cache.source === ... ) return ...` | map-painter | ~10 | высокая | низкий |
| 2 | Преамбула `const T/W/size = ...` в каждом методе | map-painter | 30 / 29 / 21 | средняя | низкий |
| 3 | Ленивая инициализация `spriteCache` + `get/set` | map-painter | 3 | средняя | низкий |
| 4 | Обход пикселей клетки `x0/y0 + два цикла` | map-painter | 3–4 | средняя | низкий |
| 5 | Обход 8 соседей вручную `for dy for dx` | оба файла | 7 | средняя | низкий |
| 6 | Разделяемое размытие (box blur) — две реализации | map-painter | 2 | средняя | средний |
| 7 | Заливка `flood fill` (BFS + visited) | map-generator | 3+ | средняя | низкий |
| 8 | Ключ кэша `[...].join('|')` | map-painter | 5 | низкая | низкий |
| 9 | `this.px(n)` вызывается в горячих циклах по пикселям | map-painter | много | средняя (скорость) | низкий |
| 10 | Кнопки-переключатели в интерфейсе (`aria-pressed`) | main.js | 4 группы | низкая | низкий |
| 11 | «Магические» соли `hashUnit(x, y, N)` | map-painter | 31 | низкая | низкий |
| 12 | Общая палитра/цветовые операции | map-painter | — | низкая | низкий |

Ниже — по каждому пункту: что именно повторяется и как вынести.

---

## 1. Кэш-«гард» (самый заметный повтор)

### Что повторяется

Один и тот же приём — «если входные данные и ключ те же, вернуть готовое» — написан вручную
десять раз, каждый раз чуть по-разному:

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

// buildRoadGeometry(), buildFog(), speckLayout(), buildPixelRegions(), buildCellMap() — то же самое
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

`const T = this.tileSize` — 30 раз, `const W = this.width` — 29, `const size = ...` — 21.
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

## 3. Ленивая инициализация `spriteCache`

### Что повторяется

Три спрайт-метода начинаются одинаково:

```js
if (!this.spriteCache) this.spriteCache = new Map();
const key = 'ore|' + kind + '|' + variant;
const cached = this.spriteCache.get(key);
if (cached) return cached;
// ... построение ...
this.spriteCache.set(key, sprite);
return sprite;
```

### Предложение

Перенести создание кэша в `constructor` (рядом с `shadeCache`, `tuftCache`) и вынести
обёртку:

```js
// В constructor: this.spriteCache = new Map();

sprite(key, build) {
    const cached = this.spriteCache.get(key);
    if (cached) return cached;
    const sprite = build();
    this.spriteCache.set(key, sprite);
    return sprite;
}
```

Тогда:

```js
oreSprite(kind, variant) {
    return this.sprite('ore|' + kind + '|' + variant, () => this.buildOreSprite(kind, variant));
}
```

Три метода теряют по 4–5 строк boilerplate, а правило кэширования становится одним.

---

## 4. Обход пикселей клетки

### Что повторяется

Несколько методов перебирают пиксели клетки вручную:

```js
const x0 = (tile % size) * T, y0 = Math.floor(tile / size) * T;
for (let yy = y0; yy < y0 + T; yy++) {
    for (let xx = x0; xx < x0 + T; xx++) {
        // ...
    }
}
```

Это встречается в `blurHeights`, `buildRiverGeometry` (сбор `solid`), и в похожем виде — в
других местах.

### Предложение

Два маленьких помощника:

```js
// Левый верхний пиксель клетки i.
tileOrigin(i) {
    return { x: (i % this.map.size) * this.tileSize, y: Math.floor(i / this.map.size) * this.tileSize };
}

// Вызвать callback для каждого пикселя клетки i.
forEachTilePixel(i, callback) {
    const { x: x0, y: y0 } = this.tileOrigin(i);
    for (let y = y0; y < y0 + this.tileSize; y++) {
        for (let x = x0; x < x0 + this.tileSize; x++) callback(x, y);
    }
}
```

Для горячих циклов, где `callback` на каждый пиксель дорог, можно оставить ручные циклы, но
имена `x0/y0` брать из `tileOrigin(i)` — тогда хотя бы вычисление координат не повторяется.

---

## 5. Обход 8 соседей

### Что повторяется

В генераторе есть готовые `neighbors(i)` и `neighbors8(i)`, но в горячих местах соседей
перебирают вручную, потому что методы возвращают новый массив (мусор для сборщика):

```js
// neighbors8, regionNeighbors, assignRegions, buildRoads, ... (генератор)
for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) { /* ... */ }
}
```

В painter'е то же самое повторяется ещё четыре раза (`blendChoices`, `isUniform`,
`paintCliffs`, `paintReliefRow`). Итого 7 копий одного обхода.

### Предложение

Общая таблица смещений и обход без аллокаций:

```js
// Общие смещения 8 направлений (порядок: N, NE, E, SE, S, SW, W, NW).
const NEIGHBORS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

// Перебор соседей клетки без создания массива.
forEachNeighbor8(x, y, size, callback) {
    for (let n = 0; n < 8; n++) {
        const nx = x + NEIGHBORS8[n][0], ny = y + NEIGHBORS8[n][1];
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) callback(ny * size + nx, nx, ny);
    }
}
```

Тогда `neighbors8` можно выразить через это (собрав результат в массив), а горячие места —
вызывать `forEachNeighbor8` напрямую. `ROAD_DIRECTIONS` уже есть и может быть **тем же**
массивом (сейчас это две независимые копии одного списка в двух файлах).

---

## 6. Две реализации размытия

### Что повторяется

Размытие по квадрату `3×3` (и вообще box blur) написано дважды и по-разному:

- `blurMountainHeights()` — двойной проход `pass(pass(...))` с окном 3×3;
- `blurHeights(height, zone, radius)` — отдельно горизонтальный, отдельно вертикальный проход
  с окном `2*radius+1`.

### Предложение

Один помощник:

```js
// Размытие box-фильтром: разделяемо (сначала строки, потом столбцы).
// zone — массив индексов клеток, где считать (или null — по всей карте).
boxBlur(source, { width, size, tile, radius = 1, zone = null, pass = 1 }) { /* ... */ }
```

`blurMountainHeights` и `blurHeights` становятся двумя вызовами с разными параметрами.
Это заметный выигрыш в читаемости (сейчас две похожие реализации легко разъедутся), но
требует аккуратной проверки: у `blurHeights` есть особенность — он считает только внутри
«зоны» гор, а вне неё значения не трогает. Значит, у помощника должен быть параметр «где
писать» (зона), иначе поведение изменится.

---

## 7. Заливка `flood fill` / BFS

### Что повторяется

`removeSmallMountains` содержит свой цикл заливки, а `removeSmallIslands` вызывает
`collectLandComponent`, где тот же BFS написан ещё раз. Плюс похожие обходы есть в
`computeWaterDepth`, `repairRegionConnectivity`, `staysConnectedWithout`.

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
`removeSmallIslands` → `accept = i => isLand(i)`. Один BFS вместо двух.

---

## 8. Ключ кэша `[...].join('|')`

Мелочь, но встречается 5 раз и легко ошибиться (забыть поле → устаревший кэш). Если
использовать помощник `memoized` из пункта 1, эта строка исчезает совсем — список входов
задаётся массивом и сравнивается поэлементно.

---

## 9. `this.px(n)` в горячих циклах (скорость)

### Что происходит

`px(n)` — это `Math.round(n * this.tileSize / 12)`. Вызов метода на каждый пиксель/деталь
дороже, чем умножение на заранее посчитанный множитель. В спрайтах (руда, эфир, дома) `pxMin`
вызывается десятки раз на спрайт — но спрайты кэшируются, так что это не горячее место.
По-настоящему горячие — циклы по миллионам пикселей (`paintBase`, рельеф, реки), но там
`px` почти не вызывается.

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

В painter'е `hashUnit(x, y, N)` вызывается 31 раз с разными числами-солями
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

## 12. Общие цветовые операции

`packRgb`, `mixPacked`, `shadePacked`, `moodize`, `shadeStep`, `fertilityTint` живут в одном
файле и уже не дублируются. Единственное, что стоит отметить: `moodize` вызывается всего
4 раза, а `mixPacked` — 23 раза; иногда `moodize(c.x)` и `mixPacked(c.x, BLACK, 0.2)`
выражают близкие вещи. Это не требует срочной правки — просто при следующих изменениях
придерживаться одного способа «приглушить цвет» (`moodize`) вместо россыпи ручных смешиваний.

---

## Что уже сделано в этой сессии

В рамках подготовки к документированию код приведён в порядок (поведение не изменилось —
проверено сравнением байт-в-байт):

1. **Секции-баннеры.** В `map-generator.js` и `map-painter.js` проставлены единые баннеры
   `SECTION: ...` (по образцу `MapGeneratorReference.js`), методы сгруппированы в порядке
   работы конвейера. Это не рефакторинг логики, а навигация по файлу.
2. **Убраны три копии `tileOf`** и **три копии `n = value => Math.max(1, this.px(value))`** —
   вынесены в методы `MapPainter.tileOf(k)` и `MapPainter.pxMin(n)`. Это ровно тот случай
   «одинаковый фрагмент в нескольких методах», о котором просил заказчик.

---

## Как проверять, что рефакторинг ничего не сломал

1. **Генерация.** Прогнать `new MapGenerator({ size: 120 }).generate(42)` до и после правки,
   сравнить результат (сериализовать нужные массивы или хэш).
2. **Отрисовка.** Прогнать `MapPainter.paint(...)` на заглушечном canvas (достаточно
   `createImageData`/`putImageData`) для всех видов × сезонов × стилей и сравнить хэш
   пикселей.
3. **Синтаксис.** `node --check map-generator.js map-painter.js`.

Если все три пункта совпадают со «старым» результатом — рефакторинг чистый.

---

## Порядок работ (рекомендация)

1. Пункт 1 (`memoized`) — самое большое сокращение и самый понятный эффект.
2. Пункты 3 и 5 (`sprite`-обёртка, общие соседи) — механические, низкий риск.
3. Пункт 7 (общий BFS) — небольшой, но затрагивает логику регионов: делать вместе с
   проверкой пункта 1 раздела «Как проверять».
4. Пункт 2 (преамбула) и 8 (ключи) — по мере касания соседнего кода.
5. Пункт 6 (общее размытие) и 9 (микрооптимизация) — только под измерением, отдельным шагом.

Не стоит делать всё сразу: каждый пункт — отдельная правка с отдельной проверкой. Так
«сломанный» шаг легко откатить, не теряя остальные улучшения.
