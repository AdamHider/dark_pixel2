/* ============================================================
   SpriteRenderer — рисует объекты (города, деревни, армии, башни...) по описанию-конфигу, пиксель за пикселем.
   Никаких готовых картинок: вы описываете объект набором фигур, а функция его рисует.

   Подключать после map-painter.js (оттуда берутся цветовые функции).

   ИСПОЛЬЗОВАНИЕ
       const sprites = new SpriteRenderer();
       const sprite = sprites.render(config, { season: 'winter', colors: { team: '#c0392b' }, frame: 0 });
       ctx.drawImage(sprite.canvas, x - sprite.anchorX, y - sprite.anchorY);

   ФОРМАТ КОНФИГА (все размеры — в пикселях для клетки 12×12; на карте масштабируются вместе с клеткой)
   {
     id: 'village',                       // имя (для вас; используется как подпись)
     size: [26, 20],                      // размер холста спрайта
     anchor: [13, 18],                    // «точка опоры» — основание объекта: ею спрайт ставится на клетку
     palette: {                           // именованные цвета
       wall: '#c8b48a',
       roof: { shade: 'wall', amount: -0.4 },      // тёмный вариант другого цвета (-1..1)
       trim: { mix: ['wall', '#ffffff', 0.3] },    // смесь двух цветов
       flag: '$team'                                // цвет, который передаст игра: options.colors.team
     },
     shadow: { rx: 9, ry: 2, alpha: 0.28 },         // овальная тень под основанием
     outline: '#241810',                  // контур 1 px вокруг силуэта (true — цвет по умолчанию); оставьте поле в 1 px
     light: 'nw',                         // откуда свет: 'nw' (по умолчанию) или 'ne' — для объёма (bevel)
     layers: [ ...фигуры... ],            // рисуются по порядку, поздние поверх ранних
     variants: {                          // отличия по сезону: ключ — название сезона из options.season
       winter: { palette: { roof: '#eef3f5' }, layers: [...] }   // layers заменяют общие, addLayers — дополняют
     }
   }

   ФИГУРЫ (общие поля: fill, bevel 0..1, alpha 0..1, when, repeat)
     { shape: 'rect',    x, y, w, h, fill }
     { shape: 'ellipse', cx, cy, rx, ry, fill }
     { shape: 'polygon', points: [[x, y], ...], fill }
     { shape: 'line',    points: [[x, y], ...], fill, width: 1 }
     { shape: 'pixels',  x, y, rows: ['..aa..', '.abba.'], legend: { a: 'wall', b: '#fff' } }   // «точечная» графика буквами
     { shape: 'scatter', area: { rect: [x, y, w, h] } | { ellipse: [cx, cy, rx, ry] }, count, colors: [...], seed }
     { shape: 'gradient', x, y, w, h, from, to, direction: 'v' | 'h', steps: 4 }
   bevel      — подсветка верхних/левых и затемнение нижних/правых краёв фигуры (0.15 — слегка)
   alpha      — полупрозрачность фигуры
   when       — { season: 'winter' | [...], frame: 0 | [0, 2], flag: 'besieged' | [...] }: фигура рисуется только при совпадении
                (frame — кадр анимации из options.frame, flag — любой из options.flags)
   repeat     — повторить фигуру: { count: 3, dx: 6, dy: 0 } или сеткой { cols: 3, rows: 2, dx: 5, dy: 4 }

   ПАРАМЕТРЫ ВЫЗОВА render(config, options)
     season   — название сезона (выбирает variants и when.season)
     colors   — значения для $имён в палитре, например { team: '#c0392b' }
     frame    — номер кадра анимации (по умолчанию 0)
     flags    — массив флагов для when.flag
     scale    — целое увеличение холста (по умолчанию 1)
     flipX    — true: отразить по горизонтали
   Возвращает { canvas, width, height, anchorX, anchorY, scale }. Результат кэшируется.
   ============================================================ */
class SpriteRenderer {
    constructor() {
        this.cache = new Map();
    }

    render(config, options = {}) {
        const key = JSON.stringify([config, options]);
        const cached = this.cache.get(key);
        if (cached) return cached;

        const resolved = this.resolveConfig(config, options);
        const [width, height] = resolved.size;
        const context = {
            options,
            palette: resolved.palette || {},
            light: resolved.light || 'nw',
            width,
            height,
            pixels: new Int32Array(width * height),   // 0 — прозрачно; старший байт — непрозрачность
            frame: options.frame || 0
        };

        if (resolved.shadow) this.drawShadow(context, resolved.shadow, resolved.anchor);
        for (const layer of resolved.layers || []) {
            if (!this.isActive(layer, options, context.frame)) continue;
            for (const offset of this.repeatOffsets(layer.repeat)) this.drawLayer(context, layer, offset[0], offset[1]);
        }
        if (resolved.outline) this.drawOutline(context, resolved.outline === true ? '#241810' : resolved.outline);

        const sprite = this.toCanvas(context, options, resolved.anchor);
        this.cache.set(key, sprite);
        return sprite;
    }

    /* ---------- Конфиг и варианты ---------- */

    // Применяет сезонный вариант: его палитра дополняет общую, layers заменяют, addLayers дополняют слои.
    resolveConfig(config, options) {
        const variant = config.variants && options.season ? config.variants[options.season] : null;
        if (!variant) return config;
        return {
            ...config,
            ...variant,
            palette: { ...config.palette, ...variant.palette },
            layers: variant.layers || [...(config.layers || []), ...(variant.addLayers || [])]
        };
    }

    isActive(layer, options, frame) {
        const when = { ...layer.when };
        if (layer.frames) when.frame = layer.frames;
        const matches = (wanted, actual) => wanted === undefined || [].concat(wanted).includes(actual);
        if (!matches(when.season, options.season) || !matches(when.frame, frame)) return false;
        if (when.flag !== undefined) return [].concat(when.flag).some(flag => (options.flags || []).includes(flag));
        return true;
    }

    repeatOffsets(repeat) {
        if (!repeat) return [[0, 0]];
        const offsets = [];
        if (repeat.cols || repeat.rows) {
            for (let r = 0; r < (repeat.rows || 1); r++) {
                for (let c = 0; c < (repeat.cols || 1); c++) offsets.push([c * (repeat.dx || 0), r * (repeat.dy || 0)]);
            }
        } else {
            for (let i = 0; i < (repeat.count || 1); i++) offsets.push([i * (repeat.dx || 0), i * (repeat.dy || 0)]);
        }
        return offsets;
    }

    /* ---------- Цвета ---------- */

    // Цвет из описания: '#hex', '$имя' (из options.colors), имя из палитры, { shade, amount }, { mix: [a, b, t] }.
    color(spec, context, depth = 0) {
        if (depth > 8) throw new Error('Цикл в палитре спрайта: ' + JSON.stringify(spec));
        if (typeof spec === 'string') {
            if (spec[0] === '#') return hexToPacked(spec.length === 4 ? '#' + [...spec.slice(1)].map(ch => ch + ch).join('') : spec);
            if (spec[0] === '$') {
                const given = context.options.colors && context.options.colors[spec.slice(1)];
                return this.color(given || '#ff00ff', context, depth + 1);   // не передали цвет — розовый, чтобы было видно
            }
            if (context.palette[spec] === undefined) throw new Error('Нет цвета в палитре: ' + spec);
            return this.color(context.palette[spec], context, depth + 1);
        }
        if (spec.shade !== undefined) return shadePacked(this.color(spec.shade, context, depth + 1), spec.amount || 0);
        if (spec.mix) return mixPacked(this.color(spec.mix[0], context, depth + 1), this.color(spec.mix[1], context, depth + 1), spec.mix[2]);
        throw new Error('Непонятное описание цвета: ' + JSON.stringify(spec));
    }

    /* ---------- Рисование слоёв ---------- */

    drawLayer(context, layer, dx, dy) {
        if (layer.shape === 'pixels') return this.drawPixels(context, layer, dx, dy);
        if (layer.shape === 'scatter') return this.drawScatter(context, layer, dx, dy);
        if (layer.shape === 'gradient') return this.drawGradient(context, layer, dx, dy);

        const mask = this.rasterize(context, layer, dx, dy);
        if (!mask) return;
        const color = this.color(layer.fill, context);
        const { width, height } = context;
        const bevel = layer.bevel || 0;
        const lit = shadePacked(color, bevel * 0.35);
        const shaded = shadePacked(color, -bevel * 0.35);
        const mirrored = context.light === 'ne';

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!mask[y * width + x]) continue;
                let result = color;
                if (bevel > 0) {
                    const open = (ox, oy) => {
                        const nx = x + ox, ny = y + oy;
                        return nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx];
                    };
                    const side = mirrored ? 1 : -1;               // с какой стороны свет по горизонтали
                    const litEdge = open(0, -1) || open(side, 0);
                    const shadeEdge = open(0, 1) || open(-side, 0);
                    if (litEdge && !shadeEdge) result = lit;
                    else if (shadeEdge && !litEdge) result = shaded;
                }
                this.setPixel(context, x, y, result, layer.alpha === undefined ? 1 : layer.alpha);
            }
        }
    }

    // Фигура -> маска (1 — пиксель принадлежит фигуре).
    rasterize(context, layer, dx, dy) {
        const { width, height } = context;
        const mask = new Uint8Array(width * height);
        const mark = (x, y) => {
            if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 1;
        };

        switch (layer.shape) {
            case 'rect':
                for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) mark(layer.x + x + dx, layer.y + y + dy);
                break;
            case 'ellipse':
                for (let y = Math.floor(layer.cy - layer.ry); y <= Math.ceil(layer.cy + layer.ry); y++) {
                    for (let x = Math.floor(layer.cx - layer.rx); x <= Math.ceil(layer.cx + layer.rx); x++) {
                        const nx = (x + 0.5 - layer.cx) / layer.rx, ny = (y + 0.5 - layer.cy) / layer.ry;
                        if (nx * nx + ny * ny <= 1) mark(x + dx, y + dy);
                    }
                }
                break;
            case 'polygon': {
                const points = layer.points;
                const ys = points.map(p => p[1]), xs = points.map(p => p[0]);
                for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
                    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
                        if (this.insidePolygon(x + 0.5, y + 0.5, points)) mark(x + dx, y + dy);
                    }
                }
                break;
            }
            case 'line': {
                const thickness = layer.width || 1;
                for (let k = 1; k < layer.points.length; k++) {
                    const [x0, y0] = layer.points[k - 1], [x1, y1] = layer.points[k];
                    for (const [px, py] of this.linePoints(x0, y0, x1, y1)) {
                        for (let oy = 0; oy < thickness; oy++) for (let ox = 0; ox < thickness; ox++) mark(px + ox + dx, py + oy + dy);
                    }
                }
                break;
            }
            default:
                throw new Error('Неизвестная фигура: ' + layer.shape);
        }
        return mask;
    }

    // Чётно-нечётный тест: лежит ли точка внутри многоугольника.
    insidePolygon(x, y, points) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [xi, yi] = points[i], [xj, yj] = points[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    linePoints(x0, y0, x1, y1) {
        const points = [];
        x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
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
    }

    // Точечная графика: строки из букв, значения букв — в legend; '.' и ' ' — пусто.
    drawPixels(context, layer, dx, dy) {
        layer.rows.forEach((row, ry) => {
            [...row].forEach((ch, rx) => {
                if (ch === '.' || ch === ' ') return;
                const spec = layer.legend && layer.legend[ch];
                if (spec === undefined) throw new Error('Нет буквы в legend: ' + ch);
                this.setPixel(context, layer.x + rx + dx, layer.y + ry + dy, this.color(spec, context), layer.alpha === undefined ? 1 : layer.alpha);
            });
        });
    }

    // «Россыпь»: случайные точки в области (одинаковые при каждом вызове благодаря seed).
    drawScatter(context, layer, dx, dy) {
        const seed = layer.seed || 1;
        const area = layer.area;
        const colors = layer.colors.map(spec => this.color(spec, context));
        for (let n = 0; n < layer.count; n++) {
            const r1 = hashUnit(n, seed, 901), r2 = hashUnit(n, seed, 902), r3 = hashUnit(n, seed, 903);
            let x, y;
            if (area.rect) {
                x = area.rect[0] + Math.floor(r1 * area.rect[2]);
                y = area.rect[1] + Math.floor(r2 * area.rect[3]);
            } else {
                const angle = r1 * Math.PI * 2, radius = Math.sqrt(r2);
                x = Math.round(area.ellipse[0] + Math.cos(angle) * radius * area.ellipse[2]);
                y = Math.round(area.ellipse[1] + Math.sin(angle) * radius * area.ellipse[3]);
            }
            this.setPixel(context, x + dx, y + dy, colors[Math.floor(r3 * colors.length)], layer.alpha === undefined ? 1 : layer.alpha);
        }
    }

    // Ступенчатый градиент между двумя цветами.
    drawGradient(context, layer, dx, dy) {
        const from = this.color(layer.from, context), to = this.color(layer.to, context);
        const steps = layer.steps || 4;
        const horizontal = layer.direction === 'h';
        const length = horizontal ? layer.w : layer.h;
        for (let y = 0; y < layer.h; y++) {
            for (let x = 0; x < layer.w; x++) {
                const t = (horizontal ? x : y) / Math.max(1, length - 1);
                const quantized = Math.round(t * (steps - 1)) / Math.max(1, steps - 1);
                this.setPixel(context, layer.x + x + dx, layer.y + y + dy, mixPacked(from, to, quantized), layer.alpha === undefined ? 1 : layer.alpha);
            }
        }
    }

    drawShadow(context, shadow, anchor) {
        const color = packRgb(0, 0, 0);
        const cx = anchor[0] + (shadow.dx || 0), cy = anchor[1] + (shadow.dy || 0);
        for (let y = Math.floor(cy - shadow.ry); y <= Math.ceil(cy + shadow.ry); y++) {
            for (let x = Math.floor(cx - shadow.rx); x <= Math.ceil(cx + shadow.rx); x++) {
                const nx = (x + 0.5 - cx) / shadow.rx, ny = (y + 0.5 - cy) / shadow.ry;
                if (nx * nx + ny * ny <= 1) this.setPixel(context, x, y, color, shadow.alpha === undefined ? 0.28 : shadow.alpha);
            }
        }
    }

    // Контур: прозрачные пиксели, у которых есть непрозрачный сосед (тень контур не создаёт).
    drawOutline(context, spec) {
        const { width, height, pixels } = context;
        const color = this.color(spec, context);
        const opaque = index => ((pixels[index] >>> 24) === 255);
        const edge = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (opaque(y * width + x)) continue;
                const touches = (x > 0 && opaque(y * width + x - 1)) || (x < width - 1 && opaque(y * width + x + 1))
                    || (y > 0 && opaque((y - 1) * width + x)) || (y < height - 1 && opaque((y + 1) * width + x));
                if (touches) edge.push(y * width + x);
            }
        }
        for (const index of edge) pixels[index] = color;
    }

    // Запись пикселя; alpha < 1 смешивает с тем, что уже нарисовано.
    setPixel(context, x, y, color, alpha) {
        if (x < 0 || y < 0 || x >= context.width || y >= context.height) return;
        const index = y * context.width + x;
        const existing = context.pixels[index];
        if (alpha >= 1) {
            context.pixels[index] = color;
        } else if ((existing >>> 24) === 0) {
            context.pixels[index] = (Math.round(alpha * 255) << 24) | (color & 0xFFFFFF);
        } else {
            context.pixels[index] = mixPacked(existing, color, alpha);
        }
    }

    /* ---------- Вывод ---------- */

    toCanvas(context, options, anchor) {
        const scale = Math.max(1, Math.round(options.scale || 1));
        const width = context.width * scale, height = context.height * scale;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(width, height);
        const out = new Int32Array(image.data.buffer);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sourceX = options.flipX ? context.width - 1 - Math.floor(x / scale) : Math.floor(x / scale);
                out[y * width + x] = context.pixels[Math.floor(y / scale) * context.width + sourceX];
            }
        }
        ctx.putImageData(image, 0, 0);

        const anchorX = options.flipX ? context.width - anchor[0] - 1 : anchor[0];
        return { canvas, width, height, anchorX: anchorX * scale, anchorY: anchor[1] * scale, scale };
    }
}
