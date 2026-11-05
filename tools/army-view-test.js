/* ============================================================
   army-view-test.js — функциональный тест ArmyView на РЕАЛЬНЫХ менеджерах.

   Заглушки только для браузерных API (canvas, rAF, performance) и для
   UI-рендерера/рендерера карты — их заменяют простые объекты, которые
   записывают вызовы. Логика армий, фокуса, приказов и подсветки — настоящая.

     node tools/army-view-test.js
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['seasons.js', 'map-generator.js', 'core-module.js', 'faction-manager.js', 'turn-manager.js',
    'economy-manager.js', 'faction-economy.js', 'construction-manager.js', 'army-manager.js', 'diplomacy-manager.js',
    'sprite-examples.js', 'sprite-bitmaps.js', 'army-view.js'];

const HARNESS = `
function __assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function __tileOf(index, size) { return { x: index % size, y: Math.floor(index / size) }; }

// Мини-шина событий: те же on/off/emit, что у Game (game.js), но без карты и рендерера.
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

    // Заглушки браузерной части.
    const renderer = { objects: null, setObjects(list) { this.objects = list; } };
    let lastArmyControls = null, lastHandlers = null;
    const ui = { renderArmyControls(controls, model, handlers) { lastArmyControls = model; lastHandlers = handlers; } };
    const notices = [];
    const view = new ArmyView().setup({
        game: Object.assign(__bus(), { armies, factions }), generator, renderer, construction,
        controls: {}, info: {}, ui, notify: text => notices.push(text)
    });

    const player = factions.playerFaction;
    const size = generator.size;

    check('спрайты: setup сразу рисует по объекту на каждую армию', () => {
        __assert(renderer.objects && renderer.objects.length === armies.armies.length, 'setup не нарисовал армии');
        view.syncObjects();
        __assert(renderer.objects.length === armies.armies.length, 'число объектов != числу армий');
        __assert(renderer.objects.every(o => String(o.id).startsWith('army-')), 'id объекта не army-*');
    });

    check('спрайты: армия — щит по эмблеме фракции, цвета — её цвет и второй цвет', () => {
        const object = renderer.objects[0];
        const config = object.config;
        __assert(/^shield_/.test(config.id), 'армия не использует щит: ' + config.id);
        __assert(Array.isArray(config.pixels) && config.legend, 'у щита нет pixels/legend');
        __assert(config.palette.field === '$team' && config.palette.mark === '$accent', 'поля щита не привязаны к цветам фракции');
        const army = armies.get(Number(String(object.id).slice(5)));
        const faction = generator.factions[army.faction];
        __assert(config.id === 'shield_' + faction.flag.emblem, 'эмблема щита не совпала с флагом фракции');
        __assert(object.options.colors.team === faction.color, 'поле щита не в цвет фракции');
        __assert(object.options.colors.accent === faction.secondaryColor, 'знак щита не во второй цвет фракции');
    });

    check('фокус: клик по своей армии берёт её в фокус', () => {
        const army = armies.armiesOf(player.id)[0];
        view.handleClick(__tileOf(army.tile, size));
        __assert(view.selectedId === army.id, 'армия не в фокусе');
        __assert(view.selected() === army, 'selected() не та армия');
    });

    check('подсветка: фокус даёт область движения и цель SELF', () => {
        view.focus(null);
        view.focus(armies.armiesOf(player.id)[0].id);
        const h = generator.highlights;   // подсветка живёт на карте (Uint8Array битовых флагов)
        __assert(h && h.length > 0, 'подсветка пуста');
        __assert(h.some(v => (v & HIGHLIGHT.SELF)), 'нет SELF');
        __assert(h.some(v => (v & HIGHLIGHT.MOVE)), 'нет MOVE');
    });

    check('движение: клик по достижимой клетке двигает армию и снимает фокус', () => {
        const army = armies.armiesOf(player.id)[0];
        const reach = armies.reachable(army);
        const target = [...reach.keys()].find(t => t !== army.tile && !armies.armyAt(t) && !armies.canAttack(army.id, t).ok);
        __assert(target !== undefined, 'нет достижимой клетки');
        view.handleClick(__tileOf(army.tile, size));            // в фокус
        view.handleClick(__tileOf(target, size));               // приказ
        __assert(armies.get(army.id).tile === target, 'армия не переместилась');
        __assert(view.selectedId === null, 'фокус не снят после приказа');
    });

    check('захват: армия берёт ровно свою клетку, а не девять вокруг', () => {
        const army = armies.armiesOf(player.id)[0];
        const own = armies.capturable(army);
        __assert(own.length <= 1, 'capturable вернул больше одной клетки: ' + own.length);
        if (own.length) __assert(own[0] === army.tile, 'захватывается не клетка армии');
        // клетка в зоне перехвата (соседняя) не должна попадать в список, если это не сама клетка армии
        const neighbors = armies.zoneTiles(army.tile, 1).filter(t => t !== army.tile);
        __assert(neighbors.every(t => !own.includes(t)), 'в захват попала соседняя клетка');
    });

    check('наведение: зона перехвата подсвечивается', () => {
        view.focus(null);
        const army = armies.armiesOf(player.id)[0];
        view.handleHover(__tileOf(army.tile, size));
        __assert(generator.highlights.some(v => (v & HIGHLIGHT.ZONE)), 'нет ZONE');
        view.handleHover(null);
    });

    check('найм: панель предлагает нанять армию в своём поселении', () => {
        const tile = generator.landTiles.find(i => generator.tileFaction[i] === player.id
            && generator.resource[i] === Resource.SETTLEMENT && armies.canRecruit(player.id, i).ok);
        __assert(tile !== undefined, 'нет поселения для найма');
        view.showControls(__tileOf(tile, size));
        const order = lastArmyControls.orders.find(o => o.label === 'Нанять армию');
        __assert(order && order.ok, 'нет доступного найма');
        const before = armies.armiesOf(player.id).length;
        lastHandlers.onOrder(order);
        __assert(armies.armiesOf(player.id).length === before + 1, 'армия не нанялась');
    });

    check('сброс: клик мимо снимает фокус', () => {
        view.focus(armies.armiesOf(player.id)[0].id);
        view.handleClick(null);
        __assert(view.selectedId === null, 'фокус не снят');
    });

    check('attach: новая карта сбрасывает фокус, анимацию и подпись', () => {
        view.focus(armies.armiesOf(player.id)[0].id);
        view.animation = { fake: true };
        view.attach(generator);
        __assert(view.selectedId === null && view.animation === null && view.signature === '', 'состояние не сброшено');
    });

    check('шина: select берёт армию в фокус, hover подсвечивает зону', () => {
        const army = armies.armiesOf(player.id)[0];
        view.game.emit('select', { tile: __tileOf(army.tile, size), region: null });
        __assert(view.selectedId === army.id, 'select не взял армию в фокус');
        view.game.emit('hover', __tileOf(army.tile, size));
        __assert(generator.highlights.some(v => (v & HIGHLIGHT.ZONE)), 'hover не подсветил зону');
        view.game.emit('hover', null);
    });

    check('шина: armies:change и built обновляют спрайты', () => {
        renderer.objects = null;
        view.game.emit('armies:change', { action: 'move' });
        __assert(renderer.objects && renderer.objects.length === armies.armies.length, 'armies:change не обновил спрайты');
        view.focus(armies.armiesOf(player.id)[0].id);
        view.game.emit('built', view.game);
        __assert(view.selectedId === null, 'built не сбросил фокус');
    });

    check('шина: teardown отписывает модуль', () => {
        view.teardown();
        view.focus(null);
        view.game.emit('select', { tile: __tileOf(armies.armiesOf(player.id)[0].tile, size), region: null });
        __assert(view.selectedId === null, 'после teardown событие всё ещё обрабатывается');
    });

    return results;
}
`;

function main() {
    const sandbox = {
        console, Math, Date, JSON, Number,
        performance: { now: () => 0 },
        requestAnimationFrame: () => 0,
        document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) }
    };
    const ctx = vm.createContext(sandbox);
    for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
    vm.runInContext(HARNESS + '\n;globalThis.__test = __test;', ctx, { filename: 'army-view-test' });
    const results = ctx.__test();
    for (const name of results) console.log('  ok  ' + name);
    console.log(`OK: ${results.length} проверок ArmyView прошли`);
}

main();
