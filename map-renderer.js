/* ============================================================
   MapRenderer — камера и взаимодействие с картой.
   Сама карта рисуется в MapPainter один раз в большой скрытый холст (buffer) в масштабе 1:1.
   Камера просто показывает нужный кусок этого холста с нужным зумом — поэтому двигать и зумить быстро.

   Камера: camera.x / camera.y — мировые координаты (в пикселях карты) левого верхнего угла экрана.
   ============================================================ */
   class MapRenderer {
    constructor(canvas, map, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.map = map;
        this.options = {
            tileSize: 16,          // размер клетки в пикселях (9, 12, 16...)
            minZoom: 0.1,
            maxZoom: 6,
            zoomStep: 1.15,        // во сколько раз меняется зум за один «щелчок» колеса
            keyPanStep: 60,        // шаг движения камеры стрелками, в экранных пикселях
            backgroundColor: '#0f1418',
            mood: 'dark',          // 'dark' (dark fantasy) | 'light'
            selectionShape: 'adaptive', // выделение клетки: 'adaptive' — по форме её ячейки на карте (у берега, рек и границ
                                        // регионов она подогнана под форму региона), 'square' — скруглённый квадрат клетки
            selectionCorner: 0,    // скругление рамки клетки в режиме 'square': доля стороны клетки (0 — прямые углы, 0.5 — круг)
            outlineSmoothing: 3,   // сколько раз скруглять углы контура выделенного региона (0 — как есть, по пикселям карты)
            autoRepaint: true,     // когда перерисовывать карту после ходов: true — при смене сезона и при видимых изменениях экономики (рост лесов и полей,
                                   // уровень поселений); 'season' — только при смене сезона (изменения экономики накопятся до него); false — никогда.
                                   // Полная перерисовка тяжёлая (секунды), а видимые изменения экономики бывают почти каждый ход.
            cellSmoothing: 2,      // сглаживание контура выделенной ячейки: сглаживаются только мелкие ступеньки вдоль воды и границ,
                                   // а прямые линии сетки и их углы остаются строго прямыми (0 — точная форма по пикселям)
            ...options
        };

        this.painter = new MapPainter(map, this.options);
        this.buffer = document.createElement('canvas'); // пока пустой; после refresh() — холст painter'а

        this.view = 'terrain';     // 'terrain' | 'temperature' | 'regions'
        this.seasonName = 'summer';
        this.mood = this.options.mood;
        this.showBorders = true;
        this.showGrid = false;     // сетка клеток поверх карты (см. setShowGrid)
        this.gridLayer = null;     // холст с линиями сетки; строится, пока сетка включена
        this.showFactions = true;  // цветные границы фракций поверх карты (см. setShowFactions)
        this.territories = null;   // свои территории (setTerritories); null — показывать состояние фракций из карты
        this.territoriesVersion = 0;
        this.factionLayer = null;  // холст со слоем фракций; строится по версии данных (map.factionVersion или territoriesVersion)
        this.factionLayerVersion = -1;
        this.camera = { x: 0, y: 0, zoom: 1 };
        this.sprites = new SpriteRenderer();
        this.objects = [];         // объекты на карте: города, армии... (см. setObjects)
        this.onObjectClick = null; // функция (object) => void — клик по объекту
        this.selection = null;     // { tile, region, edges, shape, cell } — выделенная клетка, её регион и формы для рисования
        this.onSelect = null;      // функция (tileInfo, regionInfo) => void
        this.onHover = null;       // функция (tileInfo | null) => void

        this.dragging = false;
        this.pressStart = null;
        this.lastPointer = { x: 0, y: 0 };

        // Состояние фракций, хода и экономики приходит в карту от соответствующих менеджеров; рендерер реагирует сам и ничего о них не знает.
        this.unsubscribers = [];
        this.rebuildScheduled = false;
        if (typeof map.onFactionState === 'function') this.unsubscribers.push(map.onFactionState(() => this.draw()));
        if (typeof map.onTurnState === 'function') this.unsubscribers.push(map.onTurnState(state => this.onTurnState(state)));
        if (typeof map.onEconomyState === 'function') this.unsubscribers.push(map.onEconomyState(change => this.onEconomyState(change)));

        this.bindEvents();
        new ResizeObserver(() => this.resize()).observe(canvas);
        this.resize();
    }

    // Отписаться от карты (если рендерер больше не нужен, а карта живёт дальше).
    destroy() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
    }

    /* Ход и экономика: что-то на карте изменилось. Полная перерисовка карты тяжёлая, поэтому запросы собираются: за один ход
       может поменяться и сезон, и рост лесов, а перерисуем мы один раз (в конце текущего вызова, не блокируя промежуточные шаги). */
    onTurnState(state) {
        if (!this.options.autoRepaint || !state.season || state.season === this.seasonName || !SEASONS[state.season]) return;
        this.seasonName = state.season;
        this.scheduleRebuild();
    }

    onEconomyState(change) {
        if (this.options.autoRepaint === true && change.visualChanged) this.scheduleRebuild();
    }

    scheduleRebuild() {
        if (this.rebuildScheduled || this.buffer.width === 0) return;      // до первой отрисовки (refresh) перерисовывать нечего
        this.rebuildScheduled = true;
        Promise.resolve().then(() => {
            this.rebuildScheduled = false;
            this.rebuildBuffer();
            this.draw();
        });
    }

    /* ---------- Публичные методы ---------- */

    // Вызывать после каждой новой генерации карты.
    refresh() {
        this.selection = null;
        this.rebuildBuffer();
        this.fitToView();
    }

    setView(view) {
        this.view = view;
        this.rebuildBuffer();
        this.draw();
    }

    setSeason(name) {
        if (!SEASONS[name]) return;
        this.seasonName = name;
        this.rebuildBuffer();
        this.draw();
    }

    // 'dark' — dark fantasy (приглушённые цвета, туман, мёртвые деревья, мрачные детали); 'light' — обычный стиль.
    setMood(mood) {
        this.mood = mood;
        this.rebuildBuffer();
        this.draw();
    }

    setShowSettlements(show) {
        this.painter.options.settlements = show;
        this.rebuildBuffer();
        this.draw();
    }

    setShowBorders(show) {
        this.showBorders = show;
        this.rebuildBuffer();
        this.draw();
    }

    /* Сетка клеток: линии делят регионы и всю карту на клетки. Внутри региона это обычные квадраты, а у берега, рек и границ
       регионов клетки подгоняются под форму региона. Рисуется отдельным слоем, поэтому включение не перерисовывает карту. */
    setShowGrid(show) {
        this.showGrid = show;
        this.gridLayer = show ? this.painter.paintGrid() : null;
        this.draw();
    }

    /* ---------- Фракции ---------- */

    /* Слой фракций: цветная граница и лёгкая заливка земель каждой фракции. Рисуется отдельным слоем поверх карты, поэтому
       смена владения не перерисовывает карту.

       По умолчанию слой строится из состояния, которое faction manager передал в карту (map.factions и map.tileFaction), и сам
       обновляется, когда оно меняется (map.factionVersion): менеджер вызывает свои claimTiles / claimRegion / releaseTiles,
       передаёт состояние в карту, а рендерер перерисовывается сам. Рендерер ничего не знает о менеджере.

       Если нужно показать что-то своё (спорные клетки, цели похода, зоны влияния), faction manager передаёт территории:
         renderer.setTerritories([
           { id: 'red', color: '#d94a3a', regions: [3, 4, 9], tiles: [1520, 1521] },   // регионы и/или отдельные клетки
           { id: 'zone', color: '#ffd24a', tiles: [...], fill: 0.2, border: 3 }        // fill и border — по желанию
         ]);
       renderer.setTerritories(null) возвращает показ по данным карты. Если свой список изменили на месте — вызовите
       renderer.refreshFactions(). Описание полей — у painter.paintTerritories. */
    setShowFactions(show) {
        this.showFactions = show;
        this.draw();
    }

    setTerritories(list) {
        this.territories = list ? list.slice() : null;
        this.refreshFactions();
    }

    // Пересобрать слой фракций (нужно, если свой список территорий изменили на месте).
    refreshFactions() {
        this.territoriesVersion++;
        this.factionLayerVersion = -1;
        this.draw();
    }

    // Слой строится лениво: только если фракции показываются и данные изменились с прошлого раза (~0.2 с).
    ensureFactionLayer() {
        if (!this.showFactions) return;
        const version = this.territories ? 'custom' + this.territoriesVersion : 'map' + this.map.factionVersion;
        if (this.factionLayer && this.factionLayerVersion === version) return;
        const list = this.territories || this.painter.territoriesFromMap();
        this.factionLayer = list.length > 0 ? this.painter.paintTerritories(list) : null;
        this.factionLayerVersion = version;
    }

    /* ---------- Объекты (города, деревни, армии...) ---------- */

    /* Объект рисуется по конфигу функцией SpriteRenderer, поверх карты, на экране (а не в буфере карты),
       поэтому армии можно двигать и менять без перерисовки всей карты.
         { id: 'army-1',
           config: SPRITE_EXAMPLES.army,         // описание объекта
           tile: [x, y],                         // клетка карты (основание объекта — внизу клетки)
           offset: [0, 0],                       // сдвиг в пикселях (для клетки 12×12), чтобы поставить точнее
           options: { colors: { team: '#c33' }, flags: ['marching'], frame: 0, flipX: false } }
       Сезон в options подставляется автоматически (текущий сезон карты), если вы не указали свой. */
    setObjects(list) {
        this.objects = list.slice();
        this.draw();
    }

    addObject(object) {
        this.objects = this.objects.filter(o => o.id !== object.id).concat(object);
        this.draw();
    }

    removeObject(id) {
        this.objects = this.objects.filter(o => o.id !== id);
        this.draw();
    }

    // Где на экране стоит объект: левый верхний угол и размер спрайта.
    objectBox(object) {
        const unit = this.options.tileSize / 12;                 // спрайты нарисованы для клетки 12×12
        const sprite = this.sprites.render(object.config, { season: this.seasonName, ...object.options });
        const [tileX, tileY] = object.tile;
        const [offsetX, offsetY] = object.offset || [0, 0];
        const baseX = tileX * this.options.tileSize + this.options.tileSize / 2 + offsetX * unit;
        const baseY = tileY * this.options.tileSize + this.options.tileSize * 0.85 + offsetY * unit;
        const zoom = this.camera.zoom;
        const factor = unit * zoom / sprite.scale;
        return {
            sprite,
            baseY,
            x: (baseX - this.camera.x) * zoom - sprite.anchorX * factor,
            y: (baseY - this.camera.y) * zoom - sprite.anchorY * factor,
            width: sprite.width * factor,
            height: sprite.height * factor
        };
    }

    drawObjects() {
        if (this.objects.length === 0) return;
        const { ctx, canvas } = this;
        const boxes = this.objects.map(object => ({ object, ...this.objectBox(object) }));
        boxes.sort((a, b) => a.baseY - b.baseY); // южнее (ближе) — рисуется позже и перекрывает

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        for (const box of boxes) {
            if (box.x > canvas.width || box.y > canvas.height || box.x + box.width < 0 || box.y + box.height < 0) continue;
            ctx.drawImage(box.sprite.canvas, box.x, box.y, box.width, box.height);
        }
        ctx.restore();
    }

    // Объект под точкой экрана (самый южный из перекрывающихся) или null.
    objectAt(point) {
        const hit = this.objects
            .map(object => ({ object, ...this.objectBox(object) }))
            .filter(b => point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height)
            .sort((a, b) => b.baseY - a.baseY);
        return hit.length ? hit[0].object : null;
    }

    rebuildBuffer() {
        this.buffer = this.painter.paint({ view: this.view, seasonName: this.seasonName, showBorders: this.showBorders, mood: this.mood });
        if (this.options.selectionShape === 'adaptive') this.painter.buildCellMap();   // один раз на карту, ~0.1 с
        this.gridLayer = this.showGrid ? this.painter.paintGrid() : null;
        this.factionLayerVersion = -1;            // форма территорий зависит от того, как нарисована карта — слой пересоберётся при показе
        // Форма региона и ячейки зависит от того, как нарисована карта (вид, берега) — пересчитываем контуры выделения.
        if (this.selection) {
            if (this.selection.region) this.selection.shape = this.regionShape(this.selection.region);
            this.selection.cell = this.cellShape(this.selection.tile);
        }
    }

    /* ---------- Камера ---------- */

    get worldSize() {
        return this.map.size * this.options.tileSize;
    }

    // Показать всю карту целиком по центру.
    fitToView() {
        const zoom = Math.min(this.canvas.width, this.canvas.height) / this.worldSize;
        this.camera.zoom = clamp(zoom, this.options.minZoom, this.options.maxZoom);
        this.centerOn(this.worldSize / 2, this.worldSize / 2);
    }

    centerOn(worldX, worldY) {
        this.camera.x = worldX - this.canvas.width / 2 / this.camera.zoom;
        this.camera.y = worldY - this.canvas.height / 2 / this.camera.zoom;
        this.clampCamera();
        this.draw();
    }

    // Не даём камере улететь слишком далеко: за краем карты можно видеть не больше половины экрана.
    clampCamera() {
        const cam = this.camera;
        const viewW = this.canvas.width / cam.zoom;
        const viewH = this.canvas.height / cam.zoom;
        cam.x = clamp(cam.x, -viewW / 2, this.worldSize - viewW / 2);
        cam.y = clamp(cam.y, -viewH / 2, this.worldSize - viewH / 2);
    }

    // Сдвиг камеры на dx, dy экранных пикселей (карта «едет» вслед за пальцем/мышью).
    panBy(dx, dy) {
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        this.clampCamera();
        this.draw();
    }

    // Зум так, чтобы точка под курсором осталась на месте.
    zoomAt(screenX, screenY, factor) {
        const cam = this.camera;
        const worldBefore = this.screenToWorld(screenX, screenY);

        cam.zoom = clamp(cam.zoom * factor, this.options.minZoom, this.options.maxZoom);
        cam.x = worldBefore.x - screenX / cam.zoom;
        cam.y = worldBefore.y - screenY / cam.zoom;
        this.clampCamera();
        this.draw();
    }

    screenToWorld(screenX, screenY) {
        return {
            x: this.camera.x + screenX / this.camera.zoom,
            y: this.camera.y + screenY / this.camera.zoom
        };
    }

    screenToTile(screenX, screenY) {
        const world = this.screenToWorld(screenX, screenY);
        return {
            x: Math.floor(world.x / this.options.tileSize),
            y: Math.floor(world.y / this.options.tileSize)
        };
    }

    /* ---------- Выделение по клику ---------- */

    /* Какая клетка под точкой экрана. Клетки по логике всё те же квадраты, но на карте у берега, рек и границ регионов их
       ячейки подогнаны под форму региона, поэтому в режиме 'adaptive' берём клетку той ячейки, которую человек видит под
       курсором (в остальных местах она совпадает с квадратом). */
    pickTile(screenX, screenY) {
        const square = this.screenToTile(screenX, screenY);
        if (this.options.selectionShape !== 'adaptive' || !this.painter.cellAt) return square;
        const world = this.screenToWorld(screenX, screenY);
        const cell = this.painter.cellAt(world.x, world.y);
        return cell < 0 ? square : { x: cell % this.map.size, y: Math.floor(cell / this.map.size) };
    }

    // Клик выделяет клетку, а если это суша — ещё и весь её регион.
    selectAt(point) {
        const tile = this.pickTile(point.x, point.y);
        const info = this.map.getTileInfo(tile.x, tile.y);
        if (!info) {
            this.clearSelection();
            return;
        }
        const region = this.map.getRegionInfo(info.regionId);
        this.selection = {
            tile: info,
            region,
            edges: region ? this.regionOutline(region) : [],
            shape: region ? this.regionShape(region) : null,
            cell: this.cellShape(info)
        };
        this.draw();
        if (this.onSelect) this.onSelect(info, region);
    }

    clearSelection() {
        if (!this.selection) return;
        this.selection = null;
        this.draw();
        if (this.onSelect) this.onSelect(null, null);
    }

    // Внешняя граница региона по клеткам: отрезок для каждой стороны клетки, за которой уже другой регион
    // (координаты — в клетках). Остаётся как запасной вариант и для тех, кому нужны именно клетки.
    regionOutline(region) {
        const { size, regionId } = this.map;
        const edges = [];
        for (const i of region.tiles) {
            const x = i % size;
            const y = Math.floor(i / size);
            if (x === 0 || regionId[i - 1] !== region.id) edges.push([x, y, x, y + 1]);
            if (x === size - 1 || regionId[i + 1] !== region.id) edges.push([x + 1, y, x + 1, y + 1]);
            if (y === 0 || regionId[i - size] !== region.id) edges.push([x, y, x + 1, y]);
            if (y === size - 1 || regionId[i + size] !== region.id) edges.push([x, y + 1, x + 1, y + 1]);
        }
        return edges;
    }

    /* Форма выделенного региона для рисования: { fill, stroke } — пути в мировых координатах (пикселях карты).
       Берётся из painter'а: это скруглённый контур по пикселям карты, в точности повторяющий видимые границы региона
       (вода и реки в регион не входят). Если painter контур дать не может, рисуем по клеткам, как раньше. */
    regionShape(region) {
        const loops = this.painter.regionOutline ? this.painter.regionOutline(region.id, this.options.outlineSmoothing) : null;
        if (loops && loops.length > 0) {
            const path = this.pathFromLoops(loops);
            return { fill: path, stroke: path };
        }

        const tileSize = this.options.tileSize;
        const size = this.map.size;
        const fill = new Path2D();
        for (const i of region.tiles) fill.rect((i % size) * tileSize, Math.floor(i / size) * tileSize, tileSize, tileSize);
        const stroke = new Path2D();
        for (const [x1, y1, x2, y2] of this.regionOutline(region)) {
            stroke.moveTo(x1 * tileSize, y1 * tileSize);
            stroke.lineTo(x2 * tileSize, y2 * tileSize);
        }
        return { fill, stroke };
    }

    // Замкнутые ломаные (в мировых координатах) -> Path2D.
    pathFromLoops(loops) {
        const path = new Path2D();
        for (const loop of loops) {
            path.moveTo(loop[0][0], loop[0][1]);
            for (let n = 1; n < loop.length; n++) path.lineTo(loop[n][0], loop[n][1]);
            path.closePath();
        }
        return path;
    }

    // Форма выделенной клетки: путь по контуру её ячейки на карте. null — рисовать скруглённый квадрат.
    cellShape(tile) {
        if (this.options.selectionShape !== 'adaptive' || !this.painter.cellOutline) return null;
        const loops = this.painter.cellOutline(tile.y * this.map.size + tile.x, this.options.cellSmoothing);
        return loops && loops.length > 0 ? this.pathFromLoops(loops) : null;
    }

    // Путь скруглённого прямоугольника (arcTo есть везде, в отличие от ctx.roundRect).
    roundedRectPath(x, y, width, height, radius) {
        const { ctx } = this;
        const r = Math.max(0, Math.min(radius, width / 2, height / 2));
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + width, y, x + width, y + height, r);
        ctx.arcTo(x + width, y + height, x, y + height, r);
        ctx.arcTo(x, y + height, x, y, r);
        ctx.arcTo(x, y, x + width, y, r);
        ctx.closePath();
    }

    // Рисуется поверх карты на экране, а не в буфере: выделение можно менять без перерисовки всей карты.
    drawSelection() {
        if (!this.selection) return;
        const { ctx, camera } = this;
        const tileSize = this.options.tileSize;
        const cell = tileSize * camera.zoom; // размер клетки на экране
        const screenX = tileX => (tileX * tileSize - camera.x) * camera.zoom;
        const screenY = tileY => (tileY * tileSize - camera.y) * camera.zoom;
        const { tile, region, shape, cell: cellPath } = this.selection;

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        if (region && shape) {
            // Путь задан в мировых координатах: переводим в экранные трансформом, а толщину линий делим на зум,
            // чтобы на экране она оставалась прежней.
            ctx.save();
            ctx.setTransform(camera.zoom, 0, 0, camera.zoom, -camera.x * camera.zoom, -camera.y * camera.zoom);
            ctx.fillStyle = 'rgba(255, 240, 170, 0.18)';
            ctx.fill(shape.fill, 'evenodd');

            ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.lineWidth = 5 / camera.zoom;
            ctx.stroke(shape.stroke);
            ctx.strokeStyle = '#ffe27a';
            ctx.lineWidth = 2.5 / camera.zoom;
            ctx.stroke(shape.stroke);
            ctx.restore();
        }

        if (cellPath) {
            // Ячейка: форма клетки на карте (у берега, рек и границ регионов подогнана под регион). Углы прямые, как у линий сетки.
            ctx.save();
            ctx.lineJoin = 'miter';
            ctx.setTransform(camera.zoom, 0, 0, camera.zoom, -camera.x * camera.zoom, -camera.y * camera.zoom);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
            ctx.fill(cellPath, 'evenodd');
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 4 / camera.zoom;
            ctx.stroke(cellPath);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.stroke(cellPath);
            ctx.restore();
        } else {
            const radius = cell * this.options.selectionCorner;
            this.roundedRectPath(screenX(tile.x), screenY(tile.y), cell, cell, radius);
            ctx.lineJoin = radius > 0 ? 'round' : 'miter';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ---------- Вывод на экран ---------- */

    resize() {
        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        this.clampCamera();
        this.draw();
    }

    draw() {
        const { ctx, canvas, camera } = this;
        ctx.fillStyle = this.options.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (this.buffer.width === 0) return;

        // При отдалении сглаживаем (иначе мерцает), при приближении оставляем чёткие пиксели.
        ctx.imageSmoothingEnabled = camera.zoom < 1;

        // Какой кусок мира сейчас виден, обрезанный по границам карты.
        const viewW = canvas.width / camera.zoom;
        const viewH = canvas.height / camera.zoom;
        const srcX = Math.max(0, camera.x);
        const srcY = Math.max(0, camera.y);
        const srcRight = Math.min(this.worldSize, camera.x + viewW);
        const srcBottom = Math.min(this.worldSize, camera.y + viewH);
        if (srcRight <= srcX || srcBottom <= srcY) return;

        const destX = (srcX - camera.x) * camera.zoom, destY = (srcY - camera.y) * camera.zoom;
        const destW = (srcRight - srcX) * camera.zoom, destH = (srcBottom - srcY) * camera.zoom;
        ctx.drawImage(this.buffer, srcX, srcY, srcRight - srcX, srcBottom - srcY, destX, destY, destW, destH);
        if (this.gridLayer) ctx.drawImage(this.gridLayer, srcX, srcY, srcRight - srcX, srcBottom - srcY, destX, destY, destW, destH);
        this.ensureFactionLayer();
        if (this.showFactions && this.factionLayer) ctx.drawImage(this.factionLayer, srcX, srcY, srcRight - srcX, srcBottom - srcY, destX, destY, destW, destH);
        this.drawSelection();
        this.drawObjects();
    }

    /* ---------- Управление ---------- */

    bindEvents() {
        const canvas = this.canvas;

        canvas.addEventListener('pointerdown', e => {
            this.dragging = true;
            this.lastPointer = { x: e.clientX, y: e.clientY };
            this.pressStart = { x: e.clientX, y: e.clientY };
            canvas.setPointerCapture(e.pointerId);
            canvas.classList.add('dragging');
        });

        canvas.addEventListener('pointermove', e => {
            if (this.dragging) {
                this.panBy(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y);
                this.lastPointer = { x: e.clientX, y: e.clientY };
            } else {
                this.reportHover(e);
            }
        });

        const stopDragging = () => {
            this.dragging = false;
            canvas.classList.remove('dragging');
        };
        canvas.addEventListener('pointerup', e => {
            const start = this.pressStart;
            stopDragging();
            // Клик — это нажатие без заметного перетаскивания.
            if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) {
                const point = this.pointerToCanvas(e);
                const object = this.onObjectClick ? this.objectAt(point) : null;
                if (object) this.onObjectClick(object);
                else this.selectAt(point);
            }
        });
        canvas.addEventListener('pointercancel', stopDragging);
        canvas.addEventListener('pointerleave', () => this.onHover && this.onHover(null));

        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const point = this.pointerToCanvas(e);
            const factor = e.deltaY < 0 ? this.options.zoomStep : 1 / this.options.zoomStep;
            this.zoomAt(point.x, point.y, factor);
        }, { passive: false });

        // Клавиатура: стрелки/WASD — движение, +/- — зум, Esc — снять выделение. Холст должен быть в фокусе.
        canvas.addEventListener('keydown', e => {
            const step = this.options.keyPanStep;
            const center = { x: canvas.width / 2, y: canvas.height / 2 };
            const actions = {
                ArrowLeft: () => this.panBy(step, 0), a: () => this.panBy(step, 0),
                ArrowRight: () => this.panBy(-step, 0), d: () => this.panBy(-step, 0),
                ArrowUp: () => this.panBy(0, step), w: () => this.panBy(0, step),
                ArrowDown: () => this.panBy(0, -step), s: () => this.panBy(0, -step),
                '+': () => this.zoomAt(center.x, center.y, this.options.zoomStep),
                '=': () => this.zoomAt(center.x, center.y, this.options.zoomStep),
                '-': () => this.zoomAt(center.x, center.y, 1 / this.options.zoomStep),
                Escape: () => this.clearSelection()
            };
            const action = actions[e.key];
            if (action) {
                e.preventDefault();
                action();
            }
        });
    }

    // Координаты курсора относительно холста (с учётом того, что CSS-размер может отличаться от размера холста).
    pointerToCanvas(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
            y: (e.clientY - rect.top) * (this.canvas.height / rect.height)
        };
    }

    reportHover(e) {
        if (!this.onHover) return;
        const point = this.pointerToCanvas(e);
        const tile = this.pickTile(point.x, point.y);
        this.onHover(this.map.getTileInfo(tile.x, tile.y));
    }
}