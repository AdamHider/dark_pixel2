/* ============================================================
   Сцена: горы и декорации рисуются вместе, строка за строкой сверху вниз
   (деревья, поля, руды, эфир, постройки, мрачные детали)
   ============================================================ */
{
    MapPaint.mixins.push({
        /* Все декорации собираем в один список и рисуем по возрастанию «основания» (нижней точки):
           то, что стоит ниже на карте, перекрывает то, что выше, — как в перспективе. Деревья могут свободно
           выходить за границы своей клетки: порядок всё равно будет правильным. */
        // Рисует горы и декорации вместе, строка за строкой сверху вниз: так то, что южнее (ближе к зрителю),
        // перекрывает то, что севернее, — деревья и горы перекрывают друг друга правильно.
        paintScene() {
            const items = this.layers.decorations ? this.collectDecorations() : [];
            const relief = this.layers.relief ? this.prepareReliefRows() : null;
            let next = 0;
            for (let gy = 0; gy < this.width; gy++) {
                if (relief) this.paintReliefRow(relief, gy);
                while (next < items.length && items[next].y <= gy) {
                    const item = items[next++];
                    this.cover = item.cover === true;      // деревья, дома, руды и т. п. закрывают границы и сетку; травинки и поля — нет
                    item.draw();
                    this.cover = false;
                }
            }
        },

        // Список декораций, отсортированный по «основанию» (нижней точке).
        collectDecorations() {
            const map = this.map;
            const T = this.tileSize;
            const items = [];

            // Ресурсы, которые рисуются одним рисунком: [где основание (доля клетки), закрывает ли границы и сетку, как рисовать].
            const standing = {
                [Resource.WHEAT]: [0.6, false, (x, y) => this.drawWheat(x, y)],
                [Resource.GOLD]: [0.8, true, (x, y) => this.drawOreTile(x, y, 'gold')],
                [Resource.IRON]: [0.8, true, (x, y) => this.drawOreTile(x, y, 'iron')],
                [Resource.ETHER]: [0.8, true, (x, y) => this.drawEther(x, y)]
            };

            this.forEachTile((x, y) => {
                const i = map.index(x, y);
                if (map.crossing[i]) this.paintCrossing(x, y, i);

                // На дорогах нет ни леса, ни полей, ни руд (кроме клеток поселений) — даже если карта сгенерирована старой версией.
                if (map.roadLevel[i] > 0 && map.resource[i] !== Resource.SETTLEMENT) return;

                const resource = map.resource[i];
                if (resource === Resource.WOOD) this.collectTrees(items, x, y, i);
                else if (resource === Resource.SETTLEMENT) this.collectSettlement(items, x, y, i);
                else if (resource === Resource.ETHER && this.mood === 'dark') this.emissive.push(() => this.drawEther(x, y));   // самый яркий элемент мира: после цветокоррекции
                else if (standing[resource]) {
                    const [base, cover, draw] = standing[resource];
                    items.push({ y: y * T + Math.round(T * base), x: x * T, cover, draw: () => draw(x, y) });
                }
            });

            if (this.mood === 'dark' && this.options.props) this.collectProps(items);

            items.sort((a, b) => a.y - b.y || a.x - b.x);
            return items;
        },

        // Два-три дерева на клетку, в случайных местах. Вид зависит от климата: в холодных краях ели, в тёплых лиственные.
        collectTrees(items, x, y, i) {
            const map = this.map;
            const { T } = this.dim;
            const conifer = map.biome[i] === Biome.TAIGA || map.biome[i] === Biome.TUNDRA || map.temperature[i] < 0.45;
            const withSnow = conifer && this.pal.snowOnConifers && this.seasonalTemperature(i) < SNOW_TEMPERATURE;

            const slots = [[0.26, 0.52], [0.74, 0.46], [0.5, 0.96]];
            const start = tileHash(x, y, 30) % slots.length;
            // Сколько деревьев растёт в клетке: полный лес — 2–3, молодой (экономика ещё не вырастила) — меньше, вплоть до одного.
            const full = 2 + (tileHash(x, y, 31) % 3 === 0 ? 1 : 0);
            const stage = map.growth ? growthStage(map.growth[i]) : GROWTH_STAGES;
            const count = stage === 0 ? 0 : Math.max(1, Math.round(full * stage / GROWTH_STAGES));

            for (let k = 0; k < count; k++) {
                const [fx, fy] = slots[(start + k) % slots.length];
                const cx = Math.round(x * T + fx * T + (hashUnit(x, y, 40 + k) - 0.5) * 0.25 * T);
                const base = Math.round(y * T + fy * T + (hashUnit(x, y, 50 + k) - 0.5) * 0.25 * T);
                const pick = tileHash(x, y, 60 + k);

                items.push({
                    y: base,
                    x: cx,
                    cover: true,
                    draw: () => (conifer ? this.drawConifer(cx, base, pick, withSnow) : this.drawBroadleaf(cx, base, pick))
                });
            }
        },

        // Овальная тень под деревом.
        drawShadow(cx, base, width) {
            const half = Math.floor(width / 2);
            for (let dx = -half; dx <= half; dx++) this.blend(cx + dx, base, BLACK, 0.22);
            for (let dx = -half + 1; dx <= half - 1; dx++) this.blend(cx + dx, base + 1, BLACK, 0.12);
        },

        // Лиственное дерево: округлая крона со светом сверху-слева, летом зелёное, весной в цвету, осенью рыже-золотое.
        drawBroadleaf(cx, base, pick) {
            const pal = this.pal;
            if (pal.bareTrees || hashUnit(cx, base, 79) < (pal.deadTreeChance || 0)) {   // зимой все голые; в тёмном стиле часть мертва и летом
                this.drawBareTree(cx, base, pick);
                return;
            }

            const width = this.px(7) + (pick % 2);
            const height = width;
            const trunkHeight = this.px(2) + 1;
            const trunkWidth = width >= 7 ? 2 : 1;
            const color = hexToPacked(pal.broadleaf[pick % pal.broadleaf.length]);
            const light = shadePacked(color, 0.22);
            const dark = shadePacked(color, -0.28);
            const top = base - trunkHeight - height + 2;

            this.drawShadow(cx, base, width);
            this.rect(cx - (trunkWidth >> 1), base - trunkHeight, trunkWidth, trunkHeight, this.packed.trunk);

            for (let row = 0; row < height; row++) {
                const t = ((row + 0.5) / height) * 2 - 1;
                const half = (width / 2) * Math.sqrt(1 - t * t);
                const x0 = Math.round(cx - half);
                const x1 = Math.round(cx + half) - 1;
                for (let x = x0; x <= x1; x++) {
                    const lean = (x - cx) + (row - height / 2);  // < 0 — верх-лево (освещено), > 0 — низ-право (тень)
                    let shade = lean < -width * 0.2 ? light : lean > width * 0.28 ? dark : color;
                    if (hashUnit(x, top + row, 77) < 0.12) shade = shade === dark ? color : dark; // листва «шуршит»
                    this.put(x, top + row, shade);
                }
            }

            if (pal.blossom && pick % 3 === 0) {
                const blossom = hexToPacked(pal.blossom);
                this.put(cx - 2, top + 2, blossom);
                this.put(cx + 1, top + 3, blossom);
                this.put(cx - 1, top + 5, blossom);
            }
        },

        // Голое дерево (зима): ствол и несколько веток.
        drawBareTree(cx, base, pick) {
            const trunk = this.packed.trunk;
            const height = this.px(8);
            this.drawShadow(cx, base, this.px(5));
            this.rect(cx, base - height, 1, height, trunk);

            const side = pick % 2 ? 1 : -1;
            for (let k = 1; k <= this.px(3); k++) {
                this.put(cx - k, base - height + k + 1, trunk);
                this.put(cx + k, base - height + k + 1 + (side > 0 ? 1 : 0), trunk);
            }
            this.put(cx + side, base - height - 1, trunk);
            if (this.mood === 'dark') {                                // кривые, корявые ветки
                this.put(cx + side * 2, base - height + 2, trunk);
                this.put(cx - side * 2, base - height + 4, trunk);
                this.put(cx + side, base - height + 5, trunk);
            }
        },

        // Ель: ярусы всё шире книзу; круглый год зелёная, зимой со снегом на лапах.
        drawConifer(cx, base, pick, withSnow) {
            const pal = this.pal;
            const color = hexToPacked(pal.conifer[pick % pal.conifer.length]);
            const light = shadePacked(color, 0.2);
            const dark = shadePacked(color, -0.3);
            const height = this.px(10) + (pick % 2);
            const maxHalf = Math.max(2, Math.round(this.px(6) / 2));
            const trunkHeight = this.px(2);
            const top = base - trunkHeight - height + 1;

            this.drawShadow(cx, base, this.px(6));
            this.rect(cx, base - trunkHeight, 1, trunkHeight, this.packed.trunk);

            for (let row = 0; row < height; row++) {
                const tierRow = row % 3;
                const half = Math.min(maxHalf, Math.floor(row * 0.34 + tierRow * 0.3 + 0.4));
                for (let dx = -half; dx <= half; dx++) {
                    let shade = dx < 0 ? light : dx > 0 ? dark : color;
                    if (withSnow && tierRow === 0) shade = dx > 0 ? this.packed.snowShade : this.packed.snow; // снежная кромка яруса
                    this.put(cx + dx, top + row, shade);
                }
            }
        },

        // Поле: весной ростки, летом растёт, осенью спелые колосья, зимой стерня.
        drawWheat(x, y) {
            const pal = this.pal;
            const { T } = this.dim;
            const stalk = hexToPacked(pal.wheatStalk);
            const head = hexToPacked(pal.wheatTop);
            // Густота поля: полное — 8 стеблей, неполное (экономика ещё не вырастила или уже убрала) — меньше.
            const stage = this.map.growth ? growthStage(this.map.growth[this.map.index(x, y)]) : GROWTH_STAGES;
            const stalks = Math.round(8 * stage / GROWTH_STAGES);

            for (let k = 0; k < stalks; k++) {
                const h = tileHash(x, y, 300 + k);
                const sx = x * T + (h % T);
                const sy = y * T + this.px(4) + ((h >>> 8) % (T - this.px(4)));  // основание стебля
                const variation = (h >>> 16) % 2;

                if (pal.wheatStage === 'bare') {
                    this.rect(sx, sy - 2, 1, 2, stalk);
                    continue;
                }
                const stalkHeight = (pal.wheatStage === 'sprout' ? this.px(2) : pal.wheatStage === 'growing' ? this.px(4) : this.px(5)) + variation;
                this.rect(sx, sy - stalkHeight, 1, stalkHeight, stalk);
                this.put(sx, sy - stalkHeight, head);
                if (pal.wheatStage === 'ripe') this.put(sx, sy - stalkHeight - 1, head);
            }
        },

        // Каменный выступ с вкраплениями руды. kind: 'gold' (золото — яркое, с блёстками) или 'iron' (железо — тёмное, ржавое).
        oreSprite(kind, variant) {
            const n = value => this.px1(value);
            const gold = kind === 'gold';
            const width = n(14), height = n(11);

            return this.sprite('ore|' + kind + '|' + variant, width, height, this.colors.outline, buffer => {
                const stone = gold ? [packRgb(150, 146, 150), packRgb(114, 110, 116), packRgb(78, 74, 82)] : [packRgb(120, 132, 146), packRgb(86, 96, 108), packRgb(54, 62, 74)];
                const oreLight = gold ? packRgb(255, 243, 168) : packRgb(207, 218, 228);
                const ore = gold ? packRgb(247, 212, 74) : packRgb(176, 92, 54);
                const oreDark = gold ? packRgb(168, 122, 20) : packRgb(98, 48, 30);
                const mid = width >> 1, floor = height - 2;

                // два-три камня разного размера
                const rocks = [[mid - n(3), floor - n(2), n(4), n(3)], [mid + n(2), floor - n(2) - (variant % 2), n(4), n(4)], [mid - 1, floor - n(4), n(3), n(3)]];
                for (const [cx, cy, rx, ry] of rocks) buffer.ellipse(cx, cy, rx, ry, stone[1], stone[0], stone[2]);

                // вкрапления руды: самородки на камнях (золото — крупные и яркие, железо — ржавые жилы с блеском стали)
                const spots = gold
                    ? [[mid - n(3), floor - n(3)], [mid + n(3), floor - n(3)], [mid, floor - n(5)], [mid + 1, floor - 1]]
                    : [[mid - n(3), floor - n(2)], [mid + n(2), floor - n(3)], [mid, floor - n(4)], [mid - 1, floor - 1], [mid + n(4), floor - 1]];
                spots.forEach(([sx, sy], k) => {
                    const size = gold ? (k === 2 ? n(3) : n(2)) : n(2);
                    buffer.rect(sx, sy, size, size, ore);
                    buffer.rect(sx + 1, sy + size, size, 1, oreDark);
                    buffer.rect(sx + size, sy + 1, 1, size, oreDark);
                    buffer.put(sx, sy, oreLight);
                    if (!gold && k % 2 === 0) buffer.put(sx + size - 1, sy, oreLight);
                });

                return { anchorX: mid, anchorY: floor + 1, sparkles: gold ? [[mid - n(3), floor - n(4)], [mid + n(3), floor - n(4)], [mid, floor - n(6)]] : [] };
            });
        },

        drawOreTile(x, y, kind) {
            const { T } = this.dim;
            const sprite = this.oreSprite(kind, tileHash(x, y, 80) % 3);
            const cx = x * T + Math.round(T / 2) + Math.round((hashUnit(x, y, 80) - 0.5) * 0.2 * T);
            const base = y * T + Math.round(T * 0.8) + Math.round((hashUnit(x, y, 81) - 0.5) * 0.2 * T) - this.liftAtTile(x, y);

            this.drawBuildingShadow(cx, base, this.px(7), this.px(5));
            this.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);

            // блёстки золота — в тёмном стиле светятся (рисуются после цветокоррекции)
            for (const [sx, sy] of sprite.sparkles) {
                const px = cx - sprite.anchorX + sx, py = base - sprite.anchorY + sy;
                this.emissive.push(() => {
                    this.put(px, py, packRgb(255, 255, 230));
                    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.blend(px + dx, py + dy, packRgb(255, 240, 160), 0.7);
                });
            }
        },

        // Гигантские фиолетовые кристаллы (variant 0, 1) или грибы (variant 2).
        etherSprite(variant) {
            const n = value => this.px1(value);
            const width = n(16), height = n(16);

            return this.sprite('ether|' + variant, width, height, packRgb(34, 14, 66), buffer => {
                const light = packRgb(214, 170, 255), mid = packRgb(160, 90, 240), dark = packRgb(91, 42, 158), tip = packRgb(248, 232, 255);
                const floor = height - 2;
                const middle = width >> 1;

                if (variant === 2) {
                    // гигантские грибы: светлая ножка, купол с тёмной «изнанкой» и светящимися пятнами
                    const mushroom = (cx, stem, capW, capH) => {
                        buffer.rect(cx - 1, floor - stem, 2, stem, packRgb(222, 206, 244));
                        buffer.rect(cx, floor - stem, 1, stem, packRgb(176, 156, 214));
                        const capY = floor - stem - capH + 1;
                        buffer.ellipse(cx, capY + capH - 1, capW, capH, mid, light, dark);
                        buffer.rect(cx - capW + 1, capY + capH - 1, capW * 2 - 1, 1, dark);   // изнанка шляпки
                        buffer.put(cx - 1, capY + 1, tip);
                        buffer.put(cx + 2, capY + 2, tip);
                        buffer.put(cx - capW + 2, capY + capH - 2, tip);
                    };
                    mushroom(middle - n(3), n(5), n(4), n(3));
                    mushroom(middle + n(3), n(7), n(5), n(4));
                    mushroom(middle, n(3), n(3), n(2));
                } else {
                    // кристаллы: три остроконечные призмы разной высоты (левая грань светлая, правая тёмная)
                    const crystal = (cx, crystalWidth, crystalHeight) => {
                        for (let row = 0; row < crystalHeight; row++) {
                            const half = Math.max(0, Math.round((crystalWidth / 2) * Math.min(1, (row + 1) / (crystalHeight * 0.7))));
                            const y = floor - crystalHeight + 1 + row;
                            buffer.rect(cx - half, y, half + 1, 1, light);
                            buffer.rect(cx + 1, y, half, 1, dark);
                            buffer.put(cx, y, mid);
                        }
                        buffer.put(cx, floor - crystalHeight + 1, tip);
                    };
                    crystal(middle - n(3), n(3), n(8));
                    crystal(middle + n(2), n(4), n(12));
                    crystal(middle + n(5), n(2), n(6));
                    buffer.ellipse(middle, floor, n(6), 1, dark, mid, dark);
                }
                return { anchorX: middle, anchorY: floor + 1 };
            });
        },

        drawEther(x, y) {
            const { T } = this.dim;
            const c = this.colors;
            const variant = tileHash(x, y, 90) % 3 === 2 ? 2 : tileHash(x, y, 90) % 2;
            const sprite = this.etherSprite(variant);
            const cx = x * T + Math.round(T / 2) + Math.round((hashUnit(x, y, 91) - 0.5) * 0.2 * T);
            const base = y * T + Math.round(T * 0.82) - this.liftAtTile(x, y);

            // сначала свечение (синхронно с землёй), потом сам рисунок
            this.drawLight(cx, base - this.px(5), c.riftCore, c.riftGlow, this.px(6));
            this.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);
            this.drawLight(cx, base - this.px(8), c.riftCore, c.riftGlow, this.px(3));
        },

        // На сколько пикселей поднята поверхность гор в центре клетки (руда и разломы лежат на ней, а не под ней).
        liftAtTile(x, y) {
            if (!this.reliefHeight || this.map.terrain[this.map.index(x, y)] !== Terrain.MOUNTAIN) return 0;
            const { T } = this.dim;
            const k = (y * T + (T >> 1)) * this.width + x * T + (T >> 1);
            return Math.round(this.reliefHeight[k] / 255 * this.px(this.options.mountainLift));
        },

        // Кости в сухих местах, вороны, развалины, виселицы — редко и поодиночке.
        collectProps(items) {
            const map = this.map;
            const { T } = this.dim;

            this.forEachTile((x, y) => {
                const i = map.index(x, y);
                if (map.terrain[i] !== Terrain.PLAIN || map.river[i] || map.resource[i] !== Resource.NONE || map.roadLevel[i] > 0) return;
                if (map.shore[i] === Shore.BEACH) return;

                const roll = hashUnit(x, y, 950 + this.seedSalt);
                const cx = x * T + Math.round(hashUnit(x, y, 951) * (T - 2)) + 1;
                const base = y * T + Math.round(hashUnit(x, y, 952) * (T - 4)) + 3;
                const dry = [Biome.STEPPE, Biome.DESERT, Biome.TUNDRA, Biome.SAVANNA].includes(map.biome[i]);

                if (dry && roll < 0.014) items.push({ y: base, x: cx, cover: true, draw: () => this.drawBones(cx, base) });
                else if (!dry && roll < 0.006) items.push({ y: base, x: cx, cover: true, draw: () => this.drawCrow(cx, base) });
                else if (roll > 0.994 && roll <= 0.9985) items.push({ y: base, x: cx, cover: true, draw: () => this.drawRuin(cx, base, x, y) });
                else if (roll > 0.9985) items.push({ y: base, x: cx, cover: true, draw: () => this.drawGibbet(cx, base) });
            });
        },

        drawBones(cx, base) {
            const bone = this.colors.bone;
            this.rect(cx - 2, base - 1, 5, 1, bone);
            this.put(cx - 1, base - 2, bone);
            this.put(cx + 1, base - 2, bone);
            this.rect(cx + 3, base - 2, 2, 2, bone);          // череп
            this.put(cx + 4, base - 2, this.colors.crow);      // глазница
        },

        drawCrow(cx, base) {
            const dark = this.colors.crow;
            this.rect(cx, base - 2, 3, 2, dark);
            this.put(cx - 1, base - 2, dark);
            this.put(cx + 1, base - 3, dark);
            this.put(cx - 2, base - 2, this.colors.stoneMid);  // клюв
        },

        // Обломки каменной стены и колонна.
        drawRuin(cx, base, tileX, tileY) {
            const stone = this.moodize(this.colors.chapelStone);
            const dark = shadePacked(stone, -0.25);
            const width = this.px(8);
            for (let dx = 0; dx < width; dx++) {
                const height = 1 + Math.floor(hashUnit(tileX * 7 + dx, tileY, 953) * this.px(4));   // рваный верх стены
                this.rect(cx - (width >> 1) + dx, base - height, 1, height, dx % 3 === 0 ? dark : stone);
            }
            this.rect(cx + (width >> 1), base - this.px(6), 2, this.px(6), stone);                   // колонна
            this.rect(cx + (width >> 1), base - this.px(6), 1, this.px(6), shadePacked(stone, 0.15));
            this.drawShadow(cx, base, width);
        },

        drawGibbet(cx, base) {
            const wood = this.packed.trunk;
            const height = this.px(10);
            this.drawShadow(cx, base, this.px(4));
            this.rect(cx, base - height, 1, height, wood);
            this.rect(cx, base - height, this.px(5), 1, wood);
            this.put(cx + this.px(4), base - height + 1, this.colors.stoneMid);                       // верёвка
            this.rect(cx + this.px(4) - 1, base - height + 2, 2, this.px(3), this.colors.crow);       // силуэт
        }
    });
}
