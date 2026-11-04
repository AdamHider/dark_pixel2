/* ============================================================
   DiplomacyManager — дипломатия: отношения между фракциями и дипломатические действия.

   Две вещи на каждую пару фракций:
     отношения (opinion) — число от −100 до +100: 0 — нейтралитет, ниже — антипатия и вражда, выше — симпатия и дружба;
     состояние ('war' | 'peace' | 'alliance') — война, нейтралитет (мир), союз: его хранит FactionManager (relationOf, isHostile),
     его читают армии (кого можно атаковать и чьи клетки захватывать) и художник (цвет линии статуса на границе).
   Отношения двигают действия и ход, а состояние меняют только действия: ни вражда сама по себе, ни дружба войну или союз не объявляют.

   Использование:
     const diplomacy = new DiplomacyManager(map, { factions, economy, strength: id => число });   // strength — военная сила фракции (для мира)
     diplomacy.opinion(a, b);                         // отношения: −100..100
     diplomacy.tier(value);                           // { key, name }: «Дружба», «Симпатия», «Нейтралитет», «Антипатия», «Вражда»
     diplomacy.actions(from, to);                     // что фракция from может сделать с to: [{ action, label, ok, reason, preview }]
     diplomacy.declareWar(from, to);                  // объявить войну (из нейтралитета)
     diplomacy.breakAlliance(from, to);               // расторгнуть союз (одностороннее, портит отношения)
     diplomacy.giftGold(from, to);                    // подарить золото: улучшает отношения (за деньги, с паузой между дарами)
     diplomacy.propose(from, to, 'peace' | 'alliance');   // предложить мир или союз: { accepted, evaluation } (согласие считает evaluate)
     diplomacy.evaluate(from, to, kind);              // согласится ли to: { fits, ok, score, required, reasons: [{ label, value }], reason }
     diplomacy.step(turn);                            // фаза хода: отношения дрейфуют (turns.addPhase('diplomacy', ...))
     diplomacy.onChange(event => ...);                // после любого действия и хода; event — запись журнала или { kind: 'turn' }

   Правила:
   - Объявить войну можно только из нейтралитета (с союзником сначала расторгается союз). Объявивший теряет отношения (−40 с жертвой,
     −20 у её союзников). Пока идёт война, отношения падают на 2 за ход.
   - Мир предлагают воюющим. Согласие — по сумме: половина отношений (× 0,5) + усталость от войны (+2 за ход, до +30) + соотношение сил
     (±30: слабая сторона охотнее мирится); нужно не меньше 0. После мира вражда уменьшается вдвое.
   - Союз предлагают из нейтралитета. Согласие — отношения + 15 за каждого общего врага; нужно не меньше 40. Союз нельзя заключить, если
     союзник одной стороны воюет с другой. В союзе отношения растут на 1 за ход (до 90); при нейтралитете сами возвращаются к нулю.
   - Дар золота (50) улучшает отношения (+10, не больше +20 за дар) и повторяется не чаще раза в 3 хода; во время войны дары не принимаются.
   - Журнал (log) хранит последние события: объявления войн, миры, союзы, дары.
   ============================================================ */

   class DiplomacyManager {
    static get DEFAULTS() {
        return {
            limit: 100,                                                   // отношения от −limit до +limit
            tiers: [                                                      // ярусы отношений; ярус — первый, чей min не больше значения
                { key: 'friendship', min: 40, name: 'Дружба' },
                { key: 'sympathy', min: 10, name: 'Симпатия' },
                { key: 'neutral', min: -9, name: 'Нейтралитет' },
                { key: 'antipathy', min: -39, name: 'Антипатия' },
                { key: 'enmity', min: -Infinity, name: 'Вражда' }
            ],
            drift: { war: -2, alliance: 1, peace: 1, allianceMax: 90 },   // изменение за ход: война роняет, союз растит (до allianceMax), нейтралитет тянет к нулю
            warDeclared: -40, allyOfVictim: -20,                          // объявление войны: отношения с жертвой и у её союзников
            allianceBroken: -25, allyOfBetrayed: -10,                     // разрыв союза
            peaceKeeps: 0.5,                                              // сколько вражды остаётся после мира
            allianceBonus: 10,                                            // отношения при заключении союза
            gift: { amount: 50, perGold: 0.2, max: 20, cooldown: 3 },     // дар: золото, отношений за золото, потолок за дар, пауза в ходах
            peace: { opinionWeight: 0.5, weariness: 2, wearinessCap: 30, strengthWeight: 30, required: 0 },
            alliance: { commonEnemy: 15, required: 40 },
            logSize: 30
        };
    }

    constructor(map, options = {}) {
        const { factions, economy, strength, ...rest } = options;
        if (!factions) throw new Error('DiplomacyManager: нужен factions (FactionManager)');
        this.options = { ...DiplomacyManager.DEFAULTS, ...rest };
        this.factions = factions;
        this.economy = economy || null;
        this.strength = strength || (() => 0);
        this.listeners = new Set();
        this.attach(map);
    }

    /* ============================================================
       SECTION: STATE
       Подключение к карте и состояние.
       ============================================================ */

    // Привязать менеджер к карте (в том числе заново сгенерированной): все отношения нулевые, журнал пуст.
    attach(map) {
        this.map = map;
        this.opinions = new Map();         // пара 'a-b' (a < b) -> отношения
        this.warSince = new Map();         // пара -> ход, с которого идёт война
        this.cooldowns = new Map();        // пара -> сколько ходов нельзя дарить
        this.log = [];                     // последние события, новые в конце: { turn, kind, from, to, text }
        this.turn = 0;
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    pair(a, b) {
        return a < b ? `${a}-${b}` : `${b}-${a}`;
    }

    nameOf(id) {
        const faction = this.factions.factions[id];
        return faction ? faction.name : `Фракция ${id}`;
    }

    // Состояние пары: 'war' | 'peace' | 'alliance' (хранит FactionManager).
    stateOf(a, b) {
        return this.factions.relationOf(a, b);
    }

    opinion(a, b) {
        return a === b ? 0 : this.opinions.get(this.pair(a, b)) ?? 0;
    }

    setOpinion(a, b, value) {
        const limit = this.options.limit;
        this.opinions.set(this.pair(a, b), Math.max(-limit, Math.min(limit, Math.round(value))));
    }

    changeOpinion(a, b, delta) {
        this.setOpinion(a, b, this.opinion(a, b) + delta);
    }

    // Ярус отношений: { key, name }.
    tier(value) {
        return this.options.tiers.find(tier => value >= tier.min);
    }

    // Все остальные фракции в заданном состоянии с фракцией id (например, союзники: 'alliance').
    partnersOf(id, state) {
        return this.factions.factions.filter(f => f.id !== id && this.stateOf(id, f.id) === state).map(f => f.id);
    }

    record(kind, from, to, text) {
        const entry = { turn: this.turn, kind, from, to, text };
        this.log.push(entry);
        if (this.log.length > this.options.logSize) this.log.shift();
        this.emit(entry);
        return entry;
    }

    emit(event) {
        for (const listener of [...this.listeners]) listener(event);
    }

    /* ============================================================
       SECTION: EVALUATION
       Согласие на мир и союз.
       ============================================================ */

    // Соотношение сил from и to: от −1 (to намного сильнее) до +1 (from намного сильнее).
    balance(from, to) {
        const a = this.strength(from), b = this.strength(to);
        return a + b === 0 ? 0 : (a - b) / (a + b);
    }

    // Общие враги двух фракций: те, с кем воюют обе.
    commonEnemies(a, b) {
        const enemies = this.partnersOf(a, 'war');
        return enemies.filter(c => c !== b && this.stateOf(b, c) === 'war');
    }

    // Союз невозможен, если союзник одной стороны воюет с другой.
    allianceBlocker(a, b) {
        for (const ally of this.partnersOf(a, 'alliance')) if (ally !== b && this.stateOf(ally, b) === 'war') return `Союз невозможен: ваш союзник (${this.nameOf(ally)}) в войне с ${this.nameOf(b)}`;
        for (const ally of this.partnersOf(b, 'alliance')) if (ally !== a && this.stateOf(ally, a) === 'war') return `Союз невозможен: союзник другой стороны (${this.nameOf(ally)}) в войне с вами`;
        return null;
    }

    /* Согласится ли фракция to на предложение from: kind — 'peace' или 'alliance'.
       Возвращает { fits, ok, score, required, reasons, reason }: fits — предложение вообще уместно (воюют / нейтралитет), ok — to согласится,
       reasons — из чего сложилась оценка [{ label, value }], reason — почему нет. */
    evaluate(from, to, kind) {
        const state = this.stateOf(from, to);
        const no = reason => ({ fits: false, ok: false, score: 0, required: 0, reasons: [], reason });
        if (from === to || !this.factions.factions[from] || !this.factions.factions[to]) return no('Нужны две разные фракции');

        if (kind === 'peace') {
            if (state !== 'war') return no('Вы не воюете');
            const o = this.options.peace, since = this.warSince.get(this.pair(from, to)) ?? this.turn;
            const reasons = [
                { label: 'Отношения', value: Math.round(this.opinion(from, to) * o.opinionWeight) },
                { label: 'Усталость от войны', value: Math.min(o.wearinessCap, Math.max(0, (this.turn - since) * o.weariness)) },
                { label: 'Соотношение сил', value: Math.round(this.balance(from, to) * o.strengthWeight) }
            ];
            const score = reasons.reduce((sum, r) => sum + r.value, 0);
            return { fits: true, ok: score >= o.required, score, required: o.required, reasons, reason: score >= o.required ? '' : 'Противник не хочет мира' };
        }

        if (kind === 'alliance') {
            if (state === 'alliance') return no('Вы уже в союзе');
            if (state === 'war') return no('Сначала нужен мир');
            const blocker = this.allianceBlocker(from, to);
            if (blocker) return { fits: true, ok: false, score: 0, required: this.options.alliance.required, reasons: [], reason: blocker };
            const o = this.options.alliance, common = this.commonEnemies(from, to);
            const reasons = [{ label: 'Отношения', value: this.opinion(from, to) }];
            if (common.length > 0) reasons.push({ label: `Общие враги (${common.map(c => this.nameOf(c)).join(', ')})`, value: common.length * o.commonEnemy });
            const score = reasons.reduce((sum, r) => sum + r.value, 0);
            return { fits: true, ok: score >= o.required, score, required: o.required, reasons, reason: score >= o.required ? '' : 'Недостаточно доверия для союза' };
        }
        return no(`Неизвестное предложение «${kind}»`);
    }

    /* ============================================================
       SECTION: ACTIONS
       Дипломатические действия.
       ============================================================ */

    // Объявить войну: из нейтралитета. Портит отношения с жертвой и её союзниками.
    declareWar(from, to) {
        const state = this.stateOf(from, to);
        if (from === to) throw new Error('Нельзя воевать с самим собой');
        if (state === 'war') throw new Error('Вы уже воюете');
        if (state === 'alliance') throw new Error('Сначала расторгните союз');
        this.factions.setRelation(from, to, 'war');
        this.warSince.set(this.pair(from, to), this.turn);
        this.changeOpinion(from, to, this.options.warDeclared);
        for (const ally of this.partnersOf(to, 'alliance')) if (ally !== from) this.changeOpinion(from, ally, this.options.allyOfVictim);
        return this.record('war', from, to, `${this.nameOf(from)} → ${this.nameOf(to)}: объявлена война`);
    }

    // Расторгнуть союз: односторонне, это предательство: отношения падают у партнёра и у его союзников.
    breakAlliance(from, to) {
        if (this.stateOf(from, to) !== 'alliance') throw new Error('Вы не в союзе');
        this.factions.setRelation(from, to, 'peace');
        this.changeOpinion(from, to, this.options.allianceBroken);
        for (const ally of this.partnersOf(to, 'alliance')) if (ally !== from) this.changeOpinion(from, ally, this.options.allyOfBetrayed);
        return this.record('break', from, to, `${this.nameOf(from)} → ${this.nameOf(to)}: союз расторгнут`);
    }

    // Можно ли подарить золото: { fits, ok, reason, cost }.
    canGift(from, to) {
        const cost = { gold: this.options.gift.amount };
        const no = reason => ({ fits: false, ok: false, reason, cost });
        if (from === to) return no('Нужны две разные фракции');
        if (this.stateOf(from, to) === 'war') return no('Во время войны дары не принимаются');
        const wait = this.cooldowns.get(this.pair(from, to)) ?? 0;
        if (wait > 0) return { fits: true, ok: false, reason: `Следующий дар можно отправить через ${wait} ${wait === 1 ? 'ход' : wait < 5 ? 'хода' : 'ходов'}`, cost };
        if (this.economy) {
            const afford = this.economy.canAfford(from, cost);
            if (!afford.ok) return { fits: true, ok: false, reason: `Не хватает золота: ${afford.missing.gold}`, cost };
        }
        return { fits: true, ok: true, reason: '', cost };
    }

    // Подарить золото: улучшает отношения (gift.perGold за золото, не больше gift.max); повторить можно через gift.cooldown ходов.
    giftGold(from, to) {
        const check = this.canGift(from, to);
        if (!check.ok) throw new Error(check.reason);
        const g = this.options.gift;
        if (this.economy) this.economy.spend(from, check.cost);
        const delta = Math.min(g.max, Math.round(g.amount * g.perGold));
        this.changeOpinion(from, to, delta);
        this.cooldowns.set(this.pair(from, to), g.cooldown);
        return this.record('gift', from, to, `${this.nameOf(from)} → ${this.nameOf(to)}: дар ${g.amount} золота (отношения +${delta})`);
    }

    /* Предложить мир или союз. Если to согласен — состояние меняется, иначе предложение отклоняется (и записывается в журнал).
       Возвращает { accepted, evaluation }. Неуместное предложение (не воюете, уже в союзе) — исключение. */
    propose(from, to, kind) {
        const evaluation = this.evaluate(from, to, kind);
        if (!evaluation.fits) throw new Error(evaluation.reason);
        if (!evaluation.ok) {
            this.record('refused', from, to, `${this.nameOf(from)} → ${this.nameOf(to)}: ${kind === 'peace' ? 'мир' : 'союз'} отклонён`);
            return { accepted: false, evaluation };
        }
        if (kind === 'peace') {
            this.factions.setRelation(from, to, 'peace');
            this.warSince.delete(this.pair(from, to));
            this.setOpinion(from, to, this.opinion(from, to) * this.options.peaceKeeps);
            this.record('peace', from, to, `${this.nameOf(from)} ↔ ${this.nameOf(to)}: заключён мир`);
        } else {
            this.factions.setRelation(from, to, 'alliance');
            this.changeOpinion(from, to, this.options.allianceBonus);
            this.record('alliance', from, to, `${this.nameOf(from)} ↔ ${this.nameOf(to)}: заключён союз`);
        }
        return { accepted: true, evaluation };
    }

    // Что фракция from может сделать с to: список действий для интерфейса. preview — оценка согласия (для мира и союза).
    actions(from, to) {
        if (from === to) return [];
        const state = this.stateOf(from, to);
        const list = [];
        const proposal = (action, label, kind) => {
            const evaluation = this.evaluate(from, to, kind);
            list.push({ action, label, ok: evaluation.fits && evaluation.ok, reason: evaluation.reason, preview: evaluation.fits ? evaluation : null, risky: evaluation.fits && !evaluation.ok });
        };
        if (state === 'war') proposal('peace', 'Предложить мир', 'peace');
        if (state === 'peace') {
            list.push({ action: 'war', label: 'Объявить войну', ok: true, reason: '', danger: true });
            proposal('alliance', 'Предложить союз', 'alliance');
        }
        if (state === 'alliance') list.push({ action: 'break', label: 'Расторгнуть союз', ok: true, reason: '', danger: true });
        const gift = this.canGift(from, to);
        if (gift.fits) list.push({ action: 'gift', label: `Дар: ${gift.cost.gold} золота`, ok: gift.ok, reason: gift.reason });
        return list;
    }

    // Выполнить действие из actions() по его имени ('war' | 'break' | 'gift' | 'peace' | 'alliance'). Возвращает запись журнала.
    perform(from, to, action) {
        if (action === 'war') return this.declareWar(from, to);
        if (action === 'break') return this.breakAlliance(from, to);
        if (action === 'gift') return this.giftGold(from, to);
        if (action === 'peace' || action === 'alliance') return this.propose(from, to, action);
        throw new Error(`Неизвестное действие «${action}»`);
    }

    /* ============================================================
       SECTION: TURN
       Фаза хода.
       ============================================================ */

    /* Фаза хода (turns.addPhase('diplomacy', context => diplomacy.step(context))): отношения сдвигаются сами — война роняет их,
       союз растит, при нейтралитете они возвращаются к нулю; паузы между дарами сокращаются. */
    step(turn = {}) {
        this.turn = turn.turn ?? this.turn + 1;
        const d = this.options.drift;
        const ids = this.factions.factions.map(f => f.id);
        for (const a of ids) {
            for (const b of ids) {
                if (a >= b) continue;
                const state = this.stateOf(a, b), value = this.opinion(a, b);
                if (state === 'war') this.setOpinion(a, b, value + d.war);
                else if (state === 'alliance') this.setOpinion(a, b, Math.min(d.allianceMax, value + d.alliance));
                else this.setOpinion(a, b, value > 0 ? Math.max(0, value - d.peace) : Math.min(0, value + d.peace));
            }
        }
        for (const [key, wait] of [...this.cooldowns]) {
            if (wait <= 1) this.cooldowns.delete(key);
            else this.cooldowns.set(key, wait - 1);
        }
        this.emit({ turn: this.turn, kind: 'turn' });
    }

    /* ============================================================
       SECTION: SAVE
       Сохранение (состояния войн и союзов сохраняет FactionManager).
       ============================================================ */

    getState() {
        return { opinions: [...this.opinions], warSince: [...this.warSince], cooldowns: [...this.cooldowns], log: this.log.map(e => ({ ...e })), turn: this.turn };
    }

    setState(state) {
        this.opinions = new Map(state.opinions);
        this.warSince = new Map(state.warSince);
        this.cooldowns = new Map(state.cooldowns);
        this.log = state.log.map(e => ({ ...e }));
        this.turn = state.turn;
        this.emit({ turn: this.turn, kind: 'load' });
    }
}