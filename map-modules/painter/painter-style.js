/* ============================================================
   Тёмный стиль: цветокоррекция, туман, свет
   ============================================================ */
{
    MapPaint.mixins.push({
        // Приглушает цвет построек в тёмном стиле.
        moodize(color) {
            return this.mood === 'dark' ? shadePacked(mixPacked(color, packRgb(110, 110, 110), 0.25), -0.12) : color;
        },

        /* Финальная обработка всей картинки: тёмные средние тона, холодные тени, туман над водой и низинами, виньетка.
           Яркими остаются только «источники света» (эфирные разломы, окна, костры) — они рисуются уже после. */
        applyGrading() {
            const { W } = this.dim;
            const pixels = this.pixels;
            const fog = this.buildFog();
            const fogScale = Math.min(255, Math.round((this.pal.fogStrength === undefined ? 1 : this.pal.fogStrength) * 255));
            const [lutR, lutG, lutB] = [0.95, 0.98, 1.04].map(gain =>
                Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, Math.round(255 * Math.pow(v / 255, 1.14) * gain))));
            const [fogR, fogG, fogB] = [150, 162, 170];

            const vignette = this.options.vignette;
            const falloff = length => Float32Array.from({ length }, (_, p) => {
                const edge = Math.min(1, Math.min(p, length - 1 - p) / (length * 0.3));
                return Math.round(256 * (1 - vignette * (1 - smoothstep(edge))));
            });
            const vx = falloff(W), vy = falloff(W);

            for (let y = 0; y < W; y++) {
                const rowShade = vy[y];
                for (let x = 0; x < W; x++) {
                    const k = y * W + x;
                    const color = pixels[k];
                    let r = lutR[color & 255], g = lutG[(color >>> 8) & 255], b = lutB[(color >>> 16) & 255];

                    const a = (fog[k] * fogScale) >> 8;
                    if (a > 0) {
                        r += ((fogR - r) * a) >> 8;
                        g += ((fogG - g) * a) >> 8;
                        b += ((fogB - b) * a) >> 8;
                    }
                    const shade = (vx[x] * rowShade) >> 8;
                    pixels[k] = 0xFF000000 | (((b * shade) >> 8) << 16) | (((g * shade) >> 8) << 8) | ((r * shade) >> 8);
                }
            }
        },

        // Густота тумана по пикселям (0..255): клочья шума, над водой плотнее. Считается один раз на карту.
        buildFog() {
            return this.memo('fog', [this.map.elevation, this.tileSize, this.seedSalt], () => this.computeFog());
        },

        computeFog() {
            const { W } = this.dim;
            const step = 4;                                   // туман плавный: шум считаем в четверть разрешения и растягиваем
            const lowWidth = Math.ceil(W / step) + 2;
            const low = new Uint8Array(lowWidth * lowWidth);
            const broad = new LatticeNoise(W, Math.max(8, this.px(80)), 901 + this.seedSalt);
            const fine = new LatticeNoise(W, Math.max(4, this.px(34)), 902 + this.seedSalt);
            const curve = Uint8Array.from({ length: 256 }, (_, n) => Math.round(Math.pow(n / 255, 1.3) * 0.3 * 255));

            for (let ly = 0; ly < lowWidth; ly++) {
                const y = Math.min(W - 1, ly * step);
                for (let lx = 0; lx < lowWidth; lx++) {
                    const x = Math.min(W - 1, lx * step);
                    const noise = 0.65 * broad.at(x, y) + 0.35 * fine.at(x, y);
                    const base = noise <= 0.5 ? 0 : Math.min(1, (noise - 0.5) / 0.3);
                    low[ly * lowWidth + lx] = Math.min(255, Math.round(curve[Math.round(base * 255)] * (this.waterMask[y * W + x] ? 1.15 : 1)));
                }
            }

            const fog = new Uint8Array(W * W);
            const weight = 256 / step;
            for (let y = 0; y < W; y++) {
                const rowA = ((y / step) | 0) * lowWidth, rowB = rowA + lowWidth, wy = (y % step) * weight;
                for (let x = 0; x < W; x++) {
                    const lx = (x / step) | 0, wx = (x % step) * weight;
                    const top = low[rowA + lx] * (256 - wx) + low[rowA + lx + 1] * wx;
                    const bottom = low[rowB + lx] * (256 - wx) + low[rowB + lx + 1] * wx;
                    fog[y * W + x] = (top * (256 - wy) + bottom * wy) >> 16;
                }
            }
            return fog;
        },

        // Источник света: яркий цвет и мягкое свечение вокруг. Рисуется после цветокоррекции.
        drawLight(x, y, color, glowColor, glowRadius) {
            for (let dy = -glowRadius; dy <= glowRadius; dy++) {
                for (let dx = -glowRadius; dx <= glowRadius; dx++) {
                    const distance = Math.hypot(dx, dy);
                    if (distance <= glowRadius) this.blend(x + dx, y + dy, glowColor, 0.2 * (1 - distance / (glowRadius + 1)));
                }
            }
            this.put(x, y, color);
        }
    });
}
