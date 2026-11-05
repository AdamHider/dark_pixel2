/* ============================================================
   SECTION: GAME
   Фасад игры: карта, рендерер и менеджеры в одном месте, плюс шина глобальных
   событий. main.js остаётся только разметкой и DOM-обработчиками.

   Шина событий (GameEmitter) — именованные события:
     'built'               новая карта построена (payload — игра)
     'turn:end'            конец хода (контекст TurnManager)
     'factions:change'     фракции изменились (причина)
     'construction:change' постройки и мосты изменились (запись изменения)
     'armies:change'       армии изменились (запись изменения: найм, ход, бой, роспуск)
     'diplomacy:change'    отношения изменились (запись журнала)
     'select'              клик по клетке: { tile, region }
     'hover'               наведение на клетку: tile | null
     'object:click'        клик по объекту (город, армия)

   Модули слушают шину через game.on(...) и объявляют свои события через
   game.emit(...). Менеджеры создаются один раз и переживают новую карту
   (привязываются заново), поэтому ссылки на них не меняются.

   Порядок подключения: после всех *-manager.js и faction-economy.js, перед main.js.
   ============================================================ */

/* Простая шина именованных событий: on(name, listener) возвращает функцию отписки. */
class GameEmitter {
    constructor() {
        this.listeners = new Map();
    }

    on(name, listener) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(listener);
        return () => this.off(name, listener);
    }

    off(name, listener) {
        const set = this.listeners.get(name);
        if (set) set.delete(listener);
    }

    emit(name, payload) {
        const set = this.listeners.get(name);
        if (!set) return;
        for (const listener of [...set]) listener(payload);
    }
}

class Game {
    static get DEFAULTS() {
        return {
            size: 120,
            seed: 1,
            turnsPerSeason: 3,
            // стартовые фракции берём из FactionManager, чтобы список был в одном месте (15 фракций)
            startFactions: FactionManager.DEFAULTS.factions
        };
    }

    constructor(canvas, options = {}) {
        this.options = { ...Game.DEFAULTS, ...options };
        this.bus = new GameEmitter();
        this.generator = new MapGenerator({ size: this.options.size });   // без generate(): карту строит build()
        this.renderer = new MapRenderer(canvas, this.generator);

        // Менеджеры создаются в build() — им нужна готовая карта (как раньше connectManagers).
        this.factions = null;
        this.economy = null;
        this.construction = null;
        this.armies = null;
        this.diplomacy = null;
        this.turns = null;
        this.built = false;
    }

    /* ---------- шина ---------- */

    on(name, listener) { return this.bus.on(name, listener); }
    off(name, listener) { return this.bus.off(name, listener); }
    emit(name, payload) { return this.bus.emit(name, payload); }

    /* ---------- создание и связывание ---------- */

    createManagers() {
        this.factions = new FactionManager(this.generator, { factions: this.options.startFactions });
        // Математика экономики — faction-economy.js; контракт функции — в начале economy-manager.js.
        this.economy = new EconomyManager(this.generator, { calculate: calculateFactionEconomy, ...FactionEconomy.managerOptions(this.options.turnsPerSeason) });
        this.construction = new ConstructionManager(this.generator, { economy: this.economy, factions: this.factions });
        this.armies = new ArmyManager(this.generator, { economy: this.economy, factions: this.factions, construction: this.construction });
        this.diplomacy = new DiplomacyManager(this.generator, {
            factions: this.factions, economy: this.economy,
            strength: id => this.armies.armiesOf(id).reduce((sum, army) => sum + army.strength, 0)
        });
        this.turns = new TurnManager(this.generator, { turnsPerSeason: this.options.turnsPerSeason });   // порядок сезонов — SEASON_ORDER из seasons.js
    }

    // Менеджеры сообщают о своих изменениях в шину; рендерер — о вводе. Кто на это подписан — дело main.js.
    wire() {
        this.turns.addPhase('diplomacy', context => this.diplomacy.step(context));   // отношения дрейфуют до армий и экономики
        this.turns.addPhase('armies', context => this.armies.step(context));          // сначала армии (движение, лечение, захват), потом экономика по новым владениям
        this.turns.addPhase('economy', context => this.economy.step(context));        // экономика считается раз в ход

        this.turns.onTurn(context => this.emit('turn:end', context));
        this.factions.onChange((manager, reason) => this.emit('factions:change', reason));
        this.construction.onChange(change => this.emit('construction:change', change));
        this.armies.onChange(change => this.emit('armies:change', change));
        this.diplomacy.onChange(event => this.emit('diplomacy:change', event));

        this.renderer.onSelect = (tile, region) => this.emit('select', { tile, region });
        this.renderer.onHover = tile => this.emit('hover', tile);
        this.renderer.onObjectClick = object => this.emit('object:click', object);
    }

    /* ---------- жизненный цикл ---------- */

    // Новая карта: генерация, создание (один раз) или привязка менеджеров, стартовое наполнение. Событие 'built' — в конце.
    build(seed) {
        this.generator.generate(Number(seed) || this.options.seed || 1);

        if (!this.built) {
            this.createManagers();
            this.wire();
            this.built = true;
        } else {
            this.factions.attach(this.generator);
            this.economy.attach(this.generator);
            this.construction.attach(this.generator);
            this.armies.attach(this.generator);
            this.diplomacy.attach(this.generator);
            this.turns.reset();
        }

        this.renderer.refresh();     // карта рисуется один раз и уже в сезоне, с которого начинается игра
        this.factions.generate();    // стартовые фракции: слой фракций рисуется поверх готовой карты
        this.construction.seed();    // стартовые башни (перерисует карту: башни — часть сцены)
        this.armies.seed();          // стартовые армии в поселениях рядом со столицей

        this.emit('built', this);
        return this;
    }

    // Сыграть ходы (обёртка над turns.advance; исключение пробрасывается в main.js).
    turn(count = 1) {
        return this.turns.advance(count);
    }
}
