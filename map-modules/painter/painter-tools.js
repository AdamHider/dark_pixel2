/* ============================================================
   Общие инструменты рисования: размеры, пиксели, кэш, геометрия
   ============================================================ */
{
    MapPaint.mixins.push({
        // «Пиксели для клетки 12×12» -> пиксели текущей клетки; px1 — то же, но не меньше пикселя.
        px(n) {
            return Math.round(n * this.tileSize / 12);
        },

        px1(n) {
            return Math.max(1, this.px(n));
        },

        forEachTile(callback) {
            const { size } = this.dim;
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) callback(x, y);
            }
        },

        // Есть ли среди клетки (tx, ty) и её восьми соседей такая, для которой test(индекс клетки) истинно.
        anyAround(tx, ty, test) {
            const { size } = this.dim;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = tx + dx, ny = ty + dy;
                    if (nx >= 0 && ny >= 0 && nx < size && ny < size && test(ny * size + nx)) return true;
                }
            }
            return false;
        },

        // Клетка, в которой лежит пиксель k.
        tileOf(k) {
            const { size, T, W } = this.dim;
            return Math.floor(Math.floor(k / W) / T) * size + Math.floor((k % W) / T);
        },

        // Температура клетки с учётом сезона: зимой холоднее, летом теплее.
        seasonalTemperature(i) {
            return this.map.temperature[i] + this.season.tempShift;
        },

        /* Кэш для вычислений, которые не зависят от сезона: build() вызывается заново, только если изменился хоть один из deps
           (сравниваются по ===: массивы карты, размеры, настройки). slot — имя кэша. */
        memo(slot, deps, build) {
            const cache = this.caches[slot];
            if (cache && cache.deps.every((dep, n) => dep === deps[n])) return cache.value;
            const value = build();
            this.caches[slot] = { deps, value };
            return value;
        },

        /* ---------- Пиксели ---------- */
        put(x, y, color) {
            if (x >= 0 && y >= 0 && x < this.width && y < this.width) {
                const k = y * this.width + x;
                this.pixels[k] = color;
                if (this.cover) this.spriteMask[k] = 1;
            }
        },

        blend(x, y, color, alpha) {
            if (x < 0 || y < 0 || x >= this.width || y >= this.width) return;
            const k = y * this.width + x;
            this.pixels[k] = mixPacked(this.pixels[k], color, alpha);
        },

        rect(x, y, w, h, color) {
            for (let yy = y; yy < y + h; yy++) {
                for (let xx = x; xx < x + w; xx++) this.put(xx, yy, color);
            }
        },

        // Пиксель земли: не рисуем поверх воды и реки.
        putGround(x, y, color) {
            if (x < 0 || y < 0 || x >= this.width || y >= this.width) return;
            const k = y * this.width + x;
            if (this.waterMask[k] || (this.riverMask && this.riverMask[k])) return;
            this.pixels[k] = color;
        },

        // Можно ли красить пиксель k «землёй» (дорога, двор): не вода, не река и не крутой склон горы.
        isFree(k) {
            const relief = this.reliefHeight;
            return !this.waterMask[k] && !(this.riverMask && this.riverMask[k]) && !(relief && relief[k] > 40);
        },

        /* ---------- Геометрия ---------- */
        // Пиксели отрезка (алгоритм Брезенхэма).
        linePoints(x0, y0, x1, y1) {
            const points = [];
            const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
            const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
            let error = dx + dy;
            for (;;) {
                points.push([x0, y0]);
                if (x0 === x1 && y0 === y1) break;
                const doubled = 2 * error;
                if (doubled >= dy) { error += dy; x0 += sx; }
                if (doubled <= dx) { error += dx; y0 += sy; }
            }
            return points;
        },

        // Слегка изогнутая линия между точками: середина отрезка уходит в сторону на bend (число или функция длины отрезка).
        curve(ax, ay, bx, by, bend) {
            const length = Math.hypot(bx - ax, by - ay) || 1;
            const offset = typeof bend === 'function' ? bend(length) : bend;
            const mx = (ax + bx) / 2 - ((by - ay) / length) * offset;
            const my = (ay + by) / 2 + ((bx - ax) / length) * offset;
            return [
                ...this.linePoints(Math.round(ax), Math.round(ay), Math.round(mx), Math.round(my)),
                ...this.linePoints(Math.round(mx), Math.round(my), Math.round(bx), Math.round(by))
            ];
        },

        // Центр клетки в пикселях, слегка сдвинутый хешем (saltX, saltY): так реки, дороги и мосты не идут по линейке.
        tileCenter(x, y, saltX, saltY, wobble) {
            const T = this.tileSize;
            return [x * T + T / 2 + (hashUnit(x, y, saltX) - 0.5) * wobble, y * T + T / 2 + (hashUnit(x, y, saltY) - 0.5) * wobble];
        },

        // Квадрат width×width вокруг (cx, cy): fn(k, x, y) для каждого пикселя, который можно красить (isFree).
        eachFreeInSquare(cx, cy, width, fn) {
            const W = this.width, half = width >> 1;
            for (let oy = 0; oy < width; oy++) {
                for (let ox = 0; ox < width; ox++) {
                    const x = cx + ox - half, y = cy + oy - half;
                    if (x < 0 || y < 0 || x >= W || y >= W) continue;
                    const k = y * W + x;
                    if (this.isFree(k)) fn(k, x, y);
                }
            }
        },

        /* Заливка слоями: пиксели из pending по очереди получают в target значение, за которое проголосовало большинство соседей
           (слева, справа, сверху, снизу; при равенстве — первое по порядку). vote(k, j) — значение, которое сосед j отдаёт пикселю k,
           или -1. За maxLayers шагов; возвращает пиксели, до которых заливка не дошла. */
        spreadMajority(pending, maxLayers, target, vote) {
            const W = this.width;
            for (let layer = 0; layer < maxLayers && pending.length > 0; layer++) {
                const taken = [];
                const rest = [];
                for (const k of pending) {
                    const x = k % W;
                    const a = x > 0 ? vote(k, k - 1) : -1;
                    const b = x < W - 1 ? vote(k, k + 1) : -1;
                    const c = k >= W ? vote(k, k - W) : -1;
                    const d = k < W * (W - 1) ? vote(k, k + W) : -1;
                    let best = -1, bestVotes = 0;
                    for (const value of [a, b, c, d]) {
                        if (value < 0) continue;
                        const votes = (a === value) + (b === value) + (c === value) + (d === value);
                        if (votes > bestVotes) { best = value; bestVotes = votes; }
                    }
                    if (best >= 0) taken.push(k, best); else rest.push(k);
                }
                for (let n = 0; n < taken.length; n += 2) target[taken[n]] = taken[n + 1];
                pending = rest;
            }
            return pending;
        },

        /* Спрайт (маленький рисунок: дом, руда, эфир) с кэшем по ключу. draw(buffer) рисует в прозрачный буфер width×height и возвращает
           остальные поля спрайта (точка привязки anchorX/anchorY, окна...). Контур вокруг рисунка — по настройке spriteOutline. */
        sprite(key, width, height, outlineColor, draw) {
            const cache = this.spriteCache || (this.spriteCache = new Map());
            if (cache.has(key)) return cache.get(key);

            const buffer = new PixelBuffer(width, height);
            const extra = draw(buffer);
            if (this.options.spriteOutline) buffer.outline(outlineColor);
            const sprite = { buffer, width, height, ...extra };
            cache.set(key, sprite);
            return sprite;
        },

        // Рисунок из буфера на карту: прозрачные пиксели пропускаем.
        blitSprite(buffer, left, top) {
            for (let y = 0; y < buffer.height; y++) {
                for (let x = 0; x < buffer.width; x++) {
                    const color = buffer.data[y * buffer.width + x];
                    if (color !== 0) this.put(left + x, top + y, color);
                }
            }
        },

        // Прозрачный слой размером с карту: { pixels, commit() } — рисуем в pixels, commit() возвращает готовый холст.
        createLayer() {
            const W = this.width;
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = W;
            const ctx = canvas.getContext('2d');
            const image = ctx.createImageData(W, W);
            return { pixels: new Int32Array(image.data.buffer), commit() { ctx.putImageData(image, 0, 0); return canvas; } };
        }
    });
}
