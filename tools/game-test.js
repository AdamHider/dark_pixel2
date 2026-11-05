/* ============================================================
   game-test.js — интеграционный тест фасада Game и шины событий.

   MapRenderer заменён заглушкой (нужен canvas/ResizeObserver), всё остальное —
   настоящее: генератор, менеджеры, фазы хода. Проверяем, что игра собирается,
   события ходят по шине, а новая карта переиспользует менеджеры.

     node tools/game-test.js
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['seasons.js', 'map-generator.js', 'core-module.js', 'faction-manager.js', 'turn-manager.js',
    'economy-manager.js', 'faction-economy.js', 'construction-manager.js', 'army-manager.js', 'diplomacy-manager.js',
    'game.js'];

const HARNESS = `
function __assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

function __test() {
    const results = [];
    const check = (name, fn) => { fn(); results.push(name); };

    const game = new Game({}, { size: 120 });
    const events = [];
    for (const name of ['built', 'turn:end', 'factions:change', 'construction:change', 'armies:change', 'diplomacy:change', 'select', 'hover', 'object:click']) {
        game.on(name, payload => events.push({ name, payload }));
    }
    const seen = name => events.filter(e => e.name === name);

    check('сборка: менеджеры созданы, карта сгенерирована, событие built', () => {
        game.build(42);
        for (const key of ['factions', 'economy', 'construction', 'armies', 'diplomacy', 'turns']) __assert(game[key], 'нет ' + key);
        __assert(game.generator.landTiles.length > 0, 'карта пуста');
        __assert(seen('built').length === 1, 'built не пришло');
        __assert(game.factions.factions.length === 2, 'не 2 фракции');
        __assert(game.armies.armies.length > 0, 'нет стартовых армий');
    });

    check('фазы: за ход армии, экономика и дипломатия отработали', () => {
        const before = events.length;
        game.turn(1);
        __assert(game.turns.turn === 1, 'ход не сыгран');
        __assert(seen('turn:end').length === 1, 'turn:end не пришло');
        __assert(events.length > before, 'шина молчала');
        __assert(game.economy.getFactionEconomy(0), 'нет экономики фракции');
    });

    check('армии: изменение армий объявляется в шину (armies:change)', () => {
        const army = game.armies.armiesOf(game.factions.playerFaction.id)[0];
        __assert(army, 'нет армии игрока');
        const before = seen('armies:change').length;
        game.armies.disband(army.id);
        const after = seen('armies:change');
        __assert(after.length === before + 1, 'armies:change не пришло');
        __assert(after[after.length - 1].payload.action === 'disband', 'не disband в payload');
    });

    check('ввод: рендерер шлёт select/hover/object:click в шину', () => {
        game.renderer.onSelect({ x: 1, y: 2 }, null);
        game.renderer.onHover({ x: 1, y: 2 });
        game.renderer.onObjectClick({ id: 'army-1' });
        __assert(seen('select').length === 1 && seen('select')[0].payload.tile.x === 1, 'select не пришло');
        __assert(seen('hover').length === 1, 'hover не пришло');
        __assert(seen('object:click').length === 1, 'object:click не пришло');
    });

    check('новая карта: менеджеры те же, ход сброшен, built снова', () => {
        const sameFactions = game.factions, sameArmies = game.armies;
        const oldSeed = game.generator.seed;
        game.build(777);
        __assert(game.factions === sameFactions && game.armies === sameArmies, 'менеджеры пересозданы');
        __assert(game.turns.turn === 0, 'ход не сброшен');
        __assert(game.generator.seed === 777 && game.generator.seed !== oldSeed, 'карта не сменилась');
        __assert(seen('built').length === 2, 'второе built не пришло');
        __assert(game.armies.armies.length > 0, 'нет стартовых армий на новой карте');
    });

    check('детерминизм: тот же seed — та же карта', () => {
        const a = new Game({}, { size: 120 }); a.build(5);
        const b = new Game({}, { size: 120 }); b.build(5);
        __assert(a.generator.landTiles.length === b.generator.landTiles.length, 'разное число клеток суши');
        __assert(a.generator.landTiles.every((t, i) => t === b.generator.landTiles[i]), 'разные клетки суши');
    });

    return results;
}
`;

function main() {
    // Заглушка рендерера: Game только вызывает refresh() и вешает обработчики ввода.
    const MapRenderer = class {
        constructor(canvas, map) {
            this.canvas = canvas; this.map = map;
            this.options = {}; this.onSelect = null; this.onHover = null; this.onObjectClick = null;
            this.selection = null;
        }
        refresh() {} setObjects() {} setView() {} fitToView() {} centerOn() {}
    };
    const sandbox = {
        console, Math, Date, JSON, Number, Float32Array, Uint16Array, Uint8Array, Int16Array, Map, Set,
        MapRenderer,
        document: { createElement: () => ({ getContext: () => ({}) }) }
    };
    const ctx = vm.createContext(sandbox);
    for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
    vm.runInContext(HARNESS + '\n;globalThis.__test = __test;', ctx, { filename: 'game-test' });
    const results = ctx.__test();
    for (const name of results) console.log('  ok  ' + name);
    console.log(`OK: ${results.length} проверок Game прошли`);
}

main();
