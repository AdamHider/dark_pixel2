/* ============================================================
   views-test.js — тест view-модулей (faction-view, player-view, turn-view,
   selection-view) на РЕАЛЬНЫХ менеджерах и настоящем UIRenderer.

   Заглушка только для DOM (createElement/getElementById/querySelectorAll) и
   canvas: проверяем, что панели строятся, кнопки дергают менеджеры, а ход
   обновляет строку состояния. Игровая логика — настоящая.

     node tools/views-test.js
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['seasons.js', 'map-generator.js', 'core-module.js', 'faction-manager.js', 'turn-manager.js',
    'economy-manager.js', 'faction-economy.js', 'construction-manager.js', 'army-manager.js', 'diplomacy-manager.js',
    'ui-renderer.js', 'faction-view.js', 'player-view.js', 'turn-view.js', 'selection-view.js'];

// Минимальный DOM: элементы-объекты с детьми, текстом и обработчиками; ids — из карты страницы.
const DOM_STUB = `
class __El {
    constructor(tag) {
        this.tagName = tag; this.children = []; this.attributes = {}; this.style = {};
        this.className = ''; this.dataset = {}; this.textContent = ''; this.innerHTML = '';
        this.hidden = false; this.checked = false; this.value = ''; this.listeners = {};
    }
    appendChild(child) {
        if (typeof child === 'string') child = { tagName: '#text', textContent: child, children: [], get text() { return this.textContent; } };
        this.children.push(child); child.parent = this; return child;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    prepend(...nodes) { for (const n of nodes) { this.appendChild(n); this.children.unshift(this.children.pop()); } }
    replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); } }
    // Простейшие селекторы: '.class', '#id', 'tag' — для поддерева.
    querySelectorAll(sel) { const out = []; const walk = el => { for (const c of el.children) { if (__matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    // Текстовое содержимое поддерева — для проверок, что панель реально заполнилась.
    get text() { return this.textContent + this.children.map(c => c.text).join(''); }
    get childCount() { return this.children.length; }
}

function __matches(el, sel) {
    if (sel[0] === '.') return String(el.className || '').split(/\\s+/).includes(sel.slice(1));
    if (sel[0] === '#') return el.id === sel.slice(1);
    return el.tagName === sel;
}

const __ids = ['factions', 'factions-panel', 'diplomacy-log', 'resources-bar', 'btn-my-faction', 'my-faction',
    'economy', 'turn-status', 'chip-turn', 'chip-season', 'chip-year', 'auto-turns', 'auto-interval',
    'next-turn', 'repaint-each-turn', 'selection', 'owner-controls', 'build-controls', 'edict-controls', 'toast'];
const __byId = {};
for (const id of __ids) { const el = new __El('div'); el.id = id; __byId[id] = el; }
__byId['repaint-each-turn'].checked = false;

const __seasons = ['Весна', 'Лето', 'Осень', 'Зима'].map(s => { const b = new __El('button'); b.dataset.season = s; return b; });
const __views = ['terrain'].map(v => { const b = new __El('button'); b.dataset.view = v; return b; });

globalThis.document = {
    createElement: tag => new __El(tag),
    getElementById: id => __byId[id] || null,
    querySelectorAll: sel => (sel === '[data-season]' ? __seasons : sel === '[data-view]' ? __views : []),
    body: new __El('body')
};
`;

const HARNESS = `
function __assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

// Мини-шина событий: те же on/off/emit, что у Game (game.js).
function __bus() {
    const listeners = new Map();
    return {
        on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => this.off(name, fn); },
        off(name, fn) { const set = listeners.get(name); if (set) set.delete(fn); },
        emit(name, payload) { const set = listeners.get(name); if (set) for (const fn of [...set]) fn(payload); }
    };
}

function __test() {
    const results = [];
    const check = (name, fn) => { fn(); results.push(name); };

    const TURNS_PER_SEASON = 3;
    const START_FACTIONS = [
        { name: 'Красные', color: '#d94a3a', secondaryColor: '#f2d27a', flag: { pattern: 'pale', emblem: 'star' }, regions: [4, 5] },
        { name: 'Синие', color: '#3b6fd4', secondaryColor: '#e8ecf4', flag: { pattern: 'chevron', emblem: 'tower' }, regions: [4, 5] }
    ];
    const generator = new MapGenerator({ size: 120 });
    generator.generate(42);
    const factions = new FactionManager(generator, { factions: START_FACTIONS });
    const economy = new EconomyManager(generator, { calculate: calculateFactionEconomy, ...FactionEconomy.managerOptions(TURNS_PER_SEASON) });
    const construction = new ConstructionManager(generator, { economy, factions });
    const armies = new ArmyManager(generator, { economy, factions, construction });
    const diplomacy = new DiplomacyManager(generator, { factions, economy, strength: id => armies.armiesOf(id).reduce((s, a) => s + a.strength, 0) });
    const turns = new TurnManager(generator, { turnsPerSeason: TURNS_PER_SEASON });
    turns.addPhase('diplomacy', ctx => diplomacy.step(ctx));
    turns.addPhase('armies', ctx => armies.step(ctx));
    turns.addPhase('economy', ctx => economy.step(ctx));
    factions.generate();
    construction.seed();
    armies.seed();

    // Заглушка игры: view-модули берут из неё менеджеры, рендерер и шину событий.
    const notices = [];
    const bus = __bus();
    const game = Object.assign(bus, { generator, factions, economy, construction, armies, diplomacy, turns,
        options: { turnsPerSeason: TURNS_PER_SEASON }, renderer: { options: {}, selection: null },
        turn(count = 1) { return turns.advance(count); } });
    const ui = new UIRenderer();

    check('faction-view: панель фракций и дипломатии заполняется', () => {
        const view = new FactionView().setup({ game, ui, notify: t => notices.push(t), onCenterCapital: () => {} });
        view.render();
        const panel = document.getElementById('factions');
        __assert(panel.childCount === generator.factions.length, 'строк не по числу фракций');
        __assert(panel.text.includes('Красные') && panel.text.includes('Синие'), 'нет имён фракций');
        __assert(!document.getElementById('factions-panel').hidden, 'панель скрыта');
    });

    check('faction-view: «Играть за них» меняет фракцию игрока', () => {
        const view = new FactionView().setup({ game, ui, notify: t => notices.push(t), onCenterCapital: () => {} });
        const before = factions.playerFaction.id;
        const other = generator.factions.find(f => f.id !== before);
        view.render();
        // Кнопка «Играть за них» — последняя-предпоследняя в строке другой фракции; ищем по тексту.
        const row = document.getElementById('factions').children.find(c => c.text.includes(other.name));
        const button = row.children.flatMap(c => c.children.length ? c.children : [c]).find(c => c.tagName === 'button' && c.textContent === 'Играть за них');
        __assert(button, 'нет кнопки «Играть за них»');
        button.dispatch('click');
        __assert(factions.playerFaction.id === other.id, 'фракция игрока не сменилась');
        factions.setPlayerFaction(before);
    });

    check('player-view: модель ресурсов и прогноз совпадают с экономикой', () => {
        const view = new PlayerView().setup({ game, ui, onCapital: () => {} });
        const model = view.buildModel();
        __assert(model && model.faction.id === factions.playerFaction.id, 'нет модели игрока');
        __assert(model.resources.gold.stock === economy.getFactionEconomy(factions.playerFaction.id).stockpile.gold, 'запас золота не совпал');
        const predicted = economy.predict(factions.playerFaction.id, view.nextTurnContext());
        __assert(model.forecast.turn === view.nextTurnContext().turn, 'не тот ход в прогнозе');
        __assert(Math.abs(model.forecast.values.gold - predicted.stockpile.gold) < 0.001, 'прогноз золота не совпал');
    });

    check('player-view: render заполняет панели ресурсов, фракции и экономики', () => {
        const view = new PlayerView().setup({ game, ui, onCapital: () => {} });
        view.render();
        __assert(document.getElementById('resources-bar').childCount > 0, 'панель ресурсов пуста');
        __assert(document.getElementById('my-faction').text.includes(factions.playerFaction.name), 'нет имени фракции');
        __assert(document.getElementById('economy').text.includes('Золото'), 'нет экономики');
    });

    check('turn-view: refresh показывает ход, play играет ход', () => {
        const view = new TurnView().setup({ game });
        view.refresh();
        __assert(document.getElementById('turn-status').text.includes('Ход 0'), 'нет хода 0');
        view.play(1);
        __assert(turns.turn === 1, 'ход не сыгран');
        view.refresh();   // в приложении refresh зовёт подписка на 'turn:end' (main.js)
        __assert(document.getElementById('chip-turn').textContent === 1, 'чип хода не обновился');
        __assert(document.getElementById('turn-status').text.includes('Ход 1'), 'строка хода не обновилась');
    });

    check('turn-view: until считает ходы до сезона', () => {
        const view = new TurnView().setup({ game });
        __assert(view.until(turns.season) === 0, 'до текущего сезона не 0');
        const other = turns.options.seasons.find(s => s !== turns.season);
        const k = view.until(other);
        __assert(k > 0 && turns.calendar(turns.turn + k).season === other, 'неверный переход к сезону');
    });

    check('selection-view: карточки клетки/региона и передача региона', () => {
        const armyView = { showControls: () => {}, syncObjects: () => {}, syncHighlights: () => {} };
        const view = new SelectionView().setup({ game, ui, armyView, notify: t => notices.push(t) });
        const index = generator.landTiles[0];
        const tile = generator.getTileInfo(index % generator.size, Math.floor(index / generator.size));
        const region = generator.getRegionInfo(tile.regionId);
        view.show(tile, region);
        const panel = document.getElementById('selection');
        __assert(!panel.hidden && panel.childCount === 2, 'нет карточек клетки и региона');
        __assert(panel.text.includes('Клетка'), 'нет карточки клетки');
        const owner = document.getElementById('owner-controls');
        __assert(!owner.hidden, 'нет кнопок передачи региона');
        const button = owner.children.find(c => c.tagName === 'button' && c.textContent === 'Освободить');
        button.dispatch('click');
        __assert(region.owner === -1, 'регион не освобождён');
    });

    check('selection-view: пустой клик очищает панель', () => {
        const armyView = { showControls: () => {}, syncObjects: () => {}, syncHighlights: () => {} };
        const view = new SelectionView().setup({ game, ui, armyView, notify: t => notices.push(t) });
        view.show(null, null);
        __assert(document.getElementById('selection').hidden, 'панель не скрыта');
    });

    check('шина: view-модули сами реагируют на события', () => {
        // Своя шина: ранние проверки создают views на общей и не отписываются, иначе teardown нечем проверить.
        const bus = __bus();
        const isolated = Object.assign(bus, { generator, factions, economy, construction, armies, diplomacy, turns,
            options: { turnsPerSeason: TURNS_PER_SEASON }, renderer: { options: {}, selection: null },
            turn(count = 1) { return turns.advance(count); } });

        const factionView = new FactionView().setup({ game: isolated, ui, notify: () => {}, onCenterCapital: () => {} });
        const playerView = new PlayerView().setup({ game: isolated, ui, onCapital: () => {} });
        const turnView = new TurnView().setup({ game: isolated });
        const armyView = { showControls: () => {}, syncObjects: () => {}, syncHighlights: () => {} };
        const selectionView = new SelectionView().setup({ game: isolated, ui, armyView, notify: () => {} });

        document.getElementById('factions').replaceChildren();
        document.getElementById('turn-status').textContent = '';
        isolated.emit('factions:change', 'test');
        __assert(document.getElementById('factions').childCount === generator.factions.length, 'factions:change не перерисовал панель');
        isolated.emit('turn:end', turns.calendar());
        __assert(document.getElementById('turn-status').text.includes('Ход'), 'turn:end не обновил строку хода');
        __assert(document.getElementById('resources-bar').childCount > 0, 'turn:end не обновил панель игрока');

        factionView.teardown(); playerView.teardown(); turnView.teardown(); selectionView.teardown();
        document.getElementById('factions').replaceChildren();
        document.getElementById('turn-status').textContent = '';
        isolated.emit('factions:change', 'test');
        isolated.emit('turn:end', turns.calendar());
        __assert(document.getElementById('factions').childCount === 0, 'после teardown панель всё ещё перерисовывается');
        __assert(document.getElementById('turn-status').textContent === '', 'после teardown строка хода всё ещё обновляется');
    });

    return results;
}
`;

function main() {
    const sandbox = { console, Math, Date, JSON, Number, Object, Array, String, Set, Map, Int32Array, Uint8Array, Uint16Array, Float32Array, Float64Array, Int16Array, Uint32Array, isNaN, parseInt, parseFloat,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(DOM_STUB, ctx, { filename: 'dom-stub' });
    for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
    vm.runInContext(HARNESS + '\n;globalThis.__test = __test;', ctx, { filename: 'views-test' });
    const results = ctx.__test();
    for (const name of results) console.log('  ok  ' + name);
    console.log(`OK: ${results.length} проверок view-модулей прошли`);
}

main();
