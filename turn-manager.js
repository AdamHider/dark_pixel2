/* ============================================================
   TurnManager — ходы: календарь, смена сезонов и конвейер всего, что происходит за ход.

   Отдельный от карты модуль. Он владеет временем игры (номер хода, сезон, год) и порядком действий внутри хода, а карте
   только передаёт текущее состояние (map.applyTurnState): рендерер сам переключает сезон, и карта перерисовывается.

   Ход — это цепочка фаз. Календарь продвигается всегда первым, а остальное (экономика, ИИ фракций, события...) подключается
   как фазы в нужном порядке и получает общий контекст хода:
     turns.addPhase('economy', ctx => economy.step(ctx));

   Использование:
     const turns = new TurnManager(map);                 // после map-generator.js; по умолчанию 4 сезона по 3 хода
     turns.addPhase('economy', ctx => economy.step(ctx));
     turns.nextTurn();                                   // один ход: календарь -> фазы -> оповещение подписчиков
     turns.onTurn(ctx => ui.update(ctx));                // ctx.results.economy — то, что вернула фаза economy

   Названия сезонов должны совпадать с ключами SEASONS в файле палитр (по умолчанию spring, summer, autumn, winter).
   ============================================================ */

   class TurnManager {
    static get DEFAULTS() {
        return {
            seasons: ['spring', 'summer', 'autumn', 'winter'],   // порядок сезонов в году
            turnsPerSeason: 3,                                    // сколько ходов длится сезон
            startSeason: 'spring',                                // с какого сезона начинается игра
            startTurn: 0                                          // с какого хода начинать счёт
        };
    }

    constructor(map, options = {}) {
        this.options = { ...TurnManager.DEFAULTS, ...options };
        const { seasons, turnsPerSeason, startSeason } = this.options;
        if (!Array.isArray(seasons) || seasons.length === 0) throw new Error('Нужен хотя бы один сезон');
        if (!(turnsPerSeason >= 1)) throw new Error('turnsPerSeason должно быть не меньше 1');
        if (!seasons.includes(startSeason)) throw new Error(`Стартового сезона ${startSeason} нет в списке сезонов`);

        this.map = map;
        this.turn = this.options.startTurn;       // сколько ходов сыграно (0 — игра только началась)
        this.version = 0;
        this.phases = [];                         // { name, run }
        this.listeners = new Set();
        this.push();
    }

    /* ---------- Календарь ---------- */

    // Время игры на указанный ход: { turn, year, season, seasonIndex, turnInSeason }.
    calendar(turn = this.turn) {
        const { seasons, turnsPerSeason, startSeason } = this.options;
        const seasonsPassed = Math.floor(turn / turnsPerSeason) + seasons.indexOf(startSeason);
        const seasonIndex = seasonsPassed % seasons.length;
        return {
            turn,
            year: Math.floor(seasonsPassed / seasons.length),
            season: seasons[seasonIndex],
            seasonIndex,
            turnInSeason: turn % turnsPerSeason
        };
    }

    get season() {
        return this.calendar().season;
    }

    get year() {
        return this.calendar().year;
    }

    // Передать текущее время в карту (рендерер по нему меняет сезон).
    push() {
        this.version++;
        if (typeof this.map.applyTurnState === 'function') this.map.applyTurnState({ ...this.calendar(), version: this.version });
    }

    /* ---------- Фазы хода ---------- */

    /* Подключает фазу: run(ctx) вызывается каждый ход, её результат попадает в ctx.results[name].
       По умолчанию фаза идёт последней; { before: 'имя' } или { after: 'имя' } ставят её рядом с другой. */
    addPhase(name, run, { before, after } = {}) {
        if (this.phases.some(p => p.name === name)) throw new Error(`Фаза ${name} уже есть`);
        if (typeof run !== 'function') throw new Error('Фаза должна быть функцией');
        const phase = { name, run };
        const anchor = before || after;
        if (anchor === undefined) {
            this.phases.push(phase);
            return this;
        }
        const index = this.phases.findIndex(p => p.name === anchor);
        if (index === -1) throw new Error(`Нет фазы ${anchor}`);
        this.phases.splice(before ? index : index + 1, 0, phase);
        return this;
    }

    removePhase(name) {
        this.phases = this.phases.filter(p => p.name !== name);
        return this;
    }

    get phaseNames() {
        return this.phases.map(p => p.name);
    }

    /* ---------- Ход ---------- */

    /* Один ход: продвигаем календарь, передаём время в карту, прогоняем фазы по порядку, оповещаем подписчиков.
       Возвращает контекст хода:
         { turn, year, season, seasonIndex, turnInSeason,
           previous: { ... время до хода }, seasonChanged, yearChanged,
           results: { имя фазы: что она вернула }, map } */
    nextTurn() {
        const previous = this.calendar();
        this.turn++;
        const now = this.calendar();
        const context = {
            ...now,
            previous,
            seasonChanged: now.turnInSeason === 0,        // начался новый сезон
            yearChanged: now.year !== previous.year,
            results: {},
            map: this.map
        };
        this.push();
        for (const phase of [...this.phases]) context.results[phase.name] = phase.run(context);
        for (const listener of [...this.listeners]) listener(context);
        return context;
    }

    // Сыграть несколько ходов подряд; возвращает контексты всех ходов.
    advance(count) {
        const contexts = [];
        for (let i = 0; i < count; i++) contexts.push(this.nextTurn());
        return contexts;
    }

    // Подписка на конец каждого хода: listener(контекст). Возвращает функцию отписки.
    onTurn(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------- Сохранение ---------- */

    getState() {
        return { format: 1, mapSeed: this.map.seed, turn: this.turn, options: { ...this.options, seasons: [...this.options.seasons] } };
    }

    setState(state) {
        if (!state || state.format !== 1) throw new Error('Неизвестный формат состояния ходов');
        if (state.mapSeed !== this.map.seed) throw new Error('Состояние сохранено для другой карты');
        this.options = { ...this.options, ...state.options };
        this.turn = state.turn;
        this.push();
    }
}