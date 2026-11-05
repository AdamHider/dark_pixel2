/* ============================================================
   SECTION: ARMY_VIEW
   Взаимодействие с армиями: фокус, приказы, анимация, подсветка, спрайты, панель.

   Раньше это всё жило в main.js (секция ARMIES). Теперь армия — в одном месте:
   правила в army-manager.js, а ввод/вид здесь. main.js только вызывает
   handleClick/handleHover/handleObjectClick и showControls и держит DOM.

   Как в Total War: клик по своей армии делает её активной (в фокусе); пока фокус
   есть, подсвечена область движения (гладкое пятно по суше) и цели атаки.
     клик по области движения   — армия идёт туда (плавно, с анимацией), фокус снимается;
     клик по красной цели       — армия атакует (подходит вплотную), фокус снимается;
     клик по другой своей армии — фокус переходит на неё;
     клик куда угодно ещё, Esc  — фокус снимается (клик работает как обычный выбор клетки).
   Зона перехвата подсвечивается только при наведении курсора на армию (любую).
   ============================================================ */

const HIGHLIGHT = { MOVE: 1, ZONE: 2, TARGET: 4, SELF: 8 };    // виды подсветки (битовые флаги, см. map.highlights)

class ArmyView extends ViewModule {
    static get DEFAULTS() {
        return {
            animate: true,                 // двигать фигурки плавно (позиции между клетками — дробные координаты tile); false — телепорт
            tilesPerSecond: 7              // скорость анимации
        };
    }

    constructor(options = {}) {
        super();
        this.options = { ...ArmyView.DEFAULTS, ...options };
        this.armies = null;
        this.selectedId = null;            // армия в фокусе (id) или null
        this.hoverId = null;               // армия под курсором (для подсветки её зоны перехвата)
        this.signature = '';               // что сейчас подсвечено (чтобы не перерисовывать слой зря)
        this.animation = null;             // { armyId, points: [[x, y]], cumulative, total, start, duration }
        this.demoObjects = [];             // демо-объекты кнопки «Объекты»: рисуются вместе с армиями
    }

    /* ---------- подключение ---------- */

    // Один раз: зависимости и DOM. Подписки на шину объявляет сам (ViewModule.listen).
    // Изменения армий приходят событием 'armies:change', новая карта — 'built'.
    setup({ game, generator, renderer, construction, controls, info, ui, notify }) {
        this.game = game;
        this.armies = game.armies;
        this.factions = game.factions;
        this.generator = generator;
        this.renderer = renderer;
        this.construction = construction;
        this.controls = controls;
        this.info = info;
        this.ui = ui;
        this.notify = notify;

        this.listen(game, 'armies:change', () => this.onArmiesChange());
        this.listen(game, 'factions:change', () => this.syncHighlights());
        this.listen(game, 'construction:change', () => { this.syncObjects(); this.syncHighlights(); });
        this.listen(game, 'built', () => this.attach(this.generator));
        this.listen(game, 'select', ({ tile }) => this.handleClick(tile));
        this.listen(game, 'hover', tile => this.handleHover(tile));
        this.listen(game, 'object:click', object => this.handleObjectClick(object));

        this.syncObjects();          // стартовые армии: сразу показываем спрайты (карта уже построена)
        return this;
    }

    // Новая карта: сбросить фокус и анимацию.
    attach(generator) {
        this.generator = generator;
        this.selectedId = null;
        this.hoverId = null;
        this.animation = null;
        this.signature = '';
        this.syncObjects();
    }

    /* ---------- состояние ---------- */

    selected() {
        return this.selectedId === null || !this.armies ? null : this.armies.get(this.selectedId);
    }

    // Взять армию в фокус (null — снять фокус).
    focus(id) {
        this.selectedId = id;
        this.syncHighlights();
        this.game.emit('armies:focus', id);   // окно выделения перерисовывается по событию
    }

    // После любого приказа армии, найма и хода.
    onArmiesChange() {
        this.syncObjects();
        this.syncHighlights();
    }

    describe(army) {
        const faction = this.generator.factions[army.faction];
        return {
            id: army.id, name: `Армия ${army.id}`, factionName: faction.name, mine: !!(this.factions.playerFaction && army.faction === this.factions.playerFaction.id),
            strength: army.strength, maxStrength: this.armies.options.army.strength, moves: army.moves, movesLeft: army.movesLeft,
            x: army.tile % this.generator.size, y: Math.floor(army.tile / this.generator.size)
        };
    }

    /* ---------- подсветка ---------- */

    // Область движения и цели выбранной армии, зона перехвата армии под курсором. Рисуется в лёгком слое фракций:
    // карта не перерисовывается и масштаб не сбрасывается.
    syncHighlights() {
        const army = this.selected();
        if (!army) this.selectedId = null;
        const list = [];
        if (army) {
            const preview = this.armies.preview(army);
            for (const tile of preview.reachable) list.push({ tile, kind: HIGHLIGHT.MOVE });
            for (const tile of preview.targets) list.push({ tile, kind: HIGHLIGHT.TARGET });
            list.push({ tile: preview.tile, kind: HIGHLIGHT.SELF });
        }
        const hovered = this.hoverId !== null && this.armies ? this.armies.get(this.hoverId) : null;
        if (hovered) for (const tile of this.armies.zoneTiles(hovered.tile, hovered.zone)) if (this.generator.isLand(tile)) list.push({ tile, kind: HIGHLIGHT.ZONE });
        const signature = list.map(h => `${h.tile}:${h.kind}`).join(',');
        if (signature === this.signature) return;
        this.signature = signature;
        this.generator.applyStructureState({ highlights: list });
    }

    /* ---------- спрайты ---------- */

    // Армии (цвет — основной цвет фракции) и демо-объекты.
    // Фигурка армии — растровый спрайт (sprite-bitmaps.js): тот же формат, что у black_warrior.
    syncObjects() {
        const size = this.generator.size;
        const objects = this.armies ? this.armies.armies.map(a => ({
            id: `army-${a.id}`, config: this.armySprite(),
            tile: this.animation && this.animation.armyId === a.id ? this.animatedTile(this.animation) : [a.tile % size, Math.floor(a.tile / size)],
            options: { colors: { team: this.generator.factions[a.faction].color } }
        })) : [];
        this.renderer.setObjects([...objects, ...this.demoObjects]);
    }

    // Растр армии; если sprite-bitmaps.js не подключён — фигурный спрайт из sprite-examples.js.
    armySprite() {
        return (typeof SPRITE_BITMAPS !== 'undefined' && SPRITE_BITMAPS.army_black) || SPRITE_EXAMPLES.army;
    }

    setDemoObjects(list) {
        this.demoObjects = list;
        this.syncObjects();
    }

    /* ---------- клики и наведение ---------- */

    // Клик по клетке карты (или по фигурке армии): управляет фокусом и приказами выбранной армии. Идемпотентен: клик по фигурке и по клетке под ней
    // можно обработать оба раза без побочных эффектов.
    handleClick(tile) {
        const player = this.factions && this.factions.playerFaction;
        if (!this.armies || !player) return;
        if (!tile) { if (this.selectedId !== null) this.focus(null); return; }
        const index = tile.y * this.generator.size + tile.x;
        const here = this.armies.armyAt(index);
        const army = this.selected();

        if (!army || army.faction !== player.id) {
            if (here && here.faction === player.id) this.focus(here.id);         // своя армия: в фокус
            return;
        }
        if (index === army.tile) return;                                        // повторный клик по армии в фокусе: фокус остаётся
        if (here && here.faction === player.id) { this.focus(here.id); return; } // другая своя армия: фокус переходит на неё

        const attack = this.armies.canAttack(army.id, index);
        if (attack.ok) { this.orderAttack(army, index, attack); return; }
        const reach = this.armies.reachable(army);
        if (reach.has(index)) { this.orderMove(army, index, reach); return; }
        this.focus(null);                                                       // мимо области движения: фокус снимается
    }

    orderMove(army, tile, reach) {
        const path = this.armies.path(army, tile, reach);
        this.startAnimation(army.id, [army.tile, ...path]);
        this.selectedId = null;                                                 // фокус снимается сразу: подсветка исчезает, армия идёт
        try {
            this.armies.move(army.id, tile);
        } catch (error) {
            this.animation = null;
            this.reportError(error);
            this.syncObjects();
        }
    }

    orderAttack(army, tile, attack) {
        const path = attack.stand !== army.tile ? this.armies.path(army, attack.stand) : [];
        this.startAnimation(army.id, [army.tile, ...path]);
        this.selectedId = null;
        try {
            const result = this.armies.attack(army.id, tile);
            this.notify(`Бой: потери — ${result.attackerLoss} у атакующих, ${result.defenderLoss} у обороняющихся${result.defenderDestroyed ? '; цель уничтожена' : ''}${result.attackerDestroyed ? '; ваша армия уничтожена' : ''}`);
        } catch (error) {
            this.animation = null;
            this.reportError(error);
            this.syncObjects();
        }
    }

    // Наведение: зона перехвата подсвечивается, пока курсор над армией.
    handleHover(tile) {
        const army = tile && Number.isInteger(tile.x) && this.armies ? this.armies.armyAt(tile.y * this.generator.size + tile.x) : null;
        const id = army ? army.id : null;
        if (id === this.hoverId) return;
        this.hoverId = id;
        this.syncHighlights();
    }

    // Клик по фигурке спрайтового рендерера — как по клетке под ней.
    handleObjectClick(object) {
        if (this.info) this.info.textContent = `Объект: ${object.id}`;
        const army = String(object.id).startsWith('army-') && this.armies ? this.armies.get(Number(String(object.id).slice(5))) : null;
        if (army) this.handleClick({ x: army.tile % this.generator.size, y: Math.floor(army.tile / this.generator.size) });
    }

    reportError(error) {
        if (this.notify) this.notify(error.message);
    }

    /* ---------- анимация перемещения ---------- */

    // Плавное движение фигурки по ломаной из клеток (tiles — от клетки старта до цели). Логика хода уже выполнена, анимация только показывает путь.
    startAnimation(armyId, tiles) {
        if (!this.options.animate || tiles.length < 2) return;
        const size = this.generator.size;
        const points = tiles.map(t => [t % size, Math.floor(t / size)]);
        const cumulative = [0];
        for (let k = 1; k < points.length; k++) cumulative.push(cumulative[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]));
        const total = cumulative[cumulative.length - 1];
        this.animation = { armyId, points, cumulative, total, start: performance.now(), duration: Math.max(250, (total / this.options.tilesPerSecond) * 1000) };
        requestAnimationFrame(() => this.stepAnimation());
    }

    stepAnimation() {
        if (!this.animation) return;
        if (performance.now() - this.animation.start >= this.animation.duration) this.animation = null;
        this.syncObjects();
        if (this.animation) requestAnimationFrame(() => this.stepAnimation());
    }

    // Положение фигурки в анимации (дробные координаты клетки): плавный разгон и торможение по длине пути.
    animatedTile(animation) {
        const t = Math.min(1, (performance.now() - animation.start) / animation.duration);
        const distance = (t * t * (3 - 2 * t)) * animation.total;
        let k = 1;
        while (k < animation.points.length - 1 && animation.cumulative[k] < distance) k++;
        const segment = animation.cumulative[k] - animation.cumulative[k - 1] || 1;
        const f = Math.min(1, Math.max(0, (distance - animation.cumulative[k - 1]) / segment));
        const [x0, y0] = animation.points[k - 1], [x1, y1] = animation.points[k];
        return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
    }

    /* ---------- панель армии в окне региона ---------- */

    // Карточка армии в фокусе (и чужой на выбранной клетке), «Распустить армию» и «Нанять армию» в своём поселении.
    showControls(tile) {
        const player = this.factions && this.factions.playerFaction;
        const index = tile ? tile.y * this.generator.size + tile.x : -1;
        if (!player || !this.armies) {
            this.ui.renderArmyControls(this.controls, null, {});
            return;
        }
        if (index < 0) {                                    // Esc или клик мимо: фокус снимается
            if (this.selectedId !== null) { this.selectedId = null; this.syncHighlights(); }
            this.ui.renderArmyControls(this.controls, null, {});
            return;
        }

        const army = this.selected();
        const orders = [];
        if (army && army.faction === player.id) orders.push({ label: 'Распустить армию', ok: true, danger: true, run: () => { this.selectedId = null; this.armies.disband(army.id); } });
        const recruit = this.armies.canRecruit(player.id, index);
        if (recruit.fits) orders.push({ label: 'Нанять армию', costText: this.construction.describeCost(recruit.cost), ok: recruit.ok, reason: recruit.reason, run: () => this.focus(this.armies.recruit(player.id, index).id) });

        const other = this.armies.armyAt(index);
        this.ui.renderArmyControls(this.controls, {
            army: army ? this.describe(army) : null,
            other: other && other !== army ? this.describe(other) : null,
            orders
        }, {
            onOrder: order => { try { order.run(); } catch (error) { this.reportError(error); } },
            onDeselect: () => this.focus(null)
        });
    }
}
