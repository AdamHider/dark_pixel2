/* ============================================================
   sim-baseline.js — страховочный харнесс рефакторинга МЕНЕДЖЕРОВ.

   baseline.js покрывает генератор/пейнтер/спрайты. Этот харнесс покрывает
   игровую симуляцию: фракции, ходы, экономика, строительство, армии,
   дипломатия. Сценарий детерминирован, поэтому любая правка менеджеров
   обязана дать те же хеши.

     node tools/sim-baseline.js save     записать эталон (до рефакторинга)
     node tools/sim-baseline.js check    сверить текущий код с эталоном

   Подключение менеджеров повторяет connectManagers() из main.js. Когда
   появится Game-фасад, харнесс переключится на него.
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'sim-baseline.json');

const SCRIPTS = ['seasons.js', 'map-generator.js', 'map-painter.js', 'sprite-renderer.js', 'sprite-examples.js',
    'core-module.js', 'faction-manager.js', 'turn-manager.js', 'economy-manager.js', 'faction-economy.js',
    'construction-manager.js', 'army-manager.js', 'diplomacy-manager.js'];

/* Драйвер исполняется внутри vm-контекста: он видит классы как глобальные. */
const DRIVER = `
function __stable(value) {
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (value instanceof Map) return { __map: Array.from(value.entries()).map(([k, v]) => [__stable(k), __stable(v)]) };
    if (value instanceof Set) return { __set: Array.from(value).map(__stable) };
    if (Array.isArray(value)) return value.map(__stable);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = __stable(value[key]);
    return out;
}
function __hash(value) { return new MAP_TEST.Hasher().string(JSON.stringify(__stable(value))).hex(); }

function __runSim() {
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
    const diplomacy = new DiplomacyManager(generator, {
        factions, economy, strength: id => armies.armiesOf(id).reduce((sum, a) => sum + a.strength, 0)
    });
    const turns = new TurnManager(generator, { turnsPerSeason: TURNS_PER_SEASON });
    turns.addPhase('diplomacy', ctx => diplomacy.step(ctx));
    turns.addPhase('armies', ctx => armies.step(ctx));
    turns.addPhase('economy', ctx => economy.step(ctx));

    factions.generate();
    construction.seed();
    armies.seed();

    const snapshot = () => ({
        turn: turns.getState(), factions: factions.getState(), economy: economy.getState(),
        construction: construction.getState(), armies: armies.getState(), diplomacy: diplomacy.getState(),
        tileFaction: generator.tileFaction, growth: generator.growth, population: generator.population,
        resource: generator.resource, crossing: generator.crossing,
        armyList: armies.armies.map(a => [a.id, a.faction, a.tile, a.strength, a.movesLeft]),
        factionInfo: generator.factions.map(f => factions.getFactionInfo(f.id))
    });

    const hashes = {};
    hashes['seed'] = __hash(snapshot());

    // Детерминированные приказы между ходами: найм, движение, атака, стройка.
    const order = () => {
        for (const faction of generator.factions) {
            // найм в первом подходящем поселении фракции
            const tile = generator.landTiles.find(i => generator.tileFaction[i] === faction.id
                && generator.resource[i] === Resource.SETTLEMENT && armies.canRecruit(faction.id, i).ok);
            if (tile !== undefined) { try { armies.recruit(faction.id, tile); } catch (e) {} }
            // приказы каждой армии: атака, иначе движение в минимальную достижимую клетку
            for (const army of armies.armiesOf(faction.id)) {
                let done = false;
                const reach = armies.reachable(army);
                for (const target of [...reach].sort((a, b) => a - b)) {
                    if (target === army.tile) continue;
                    const attack = armies.canAttack(army.id, target);
                    if (attack.ok) { try { armies.attack(army.id, target); done = true; } catch (e) {} break; }
                }
                if (done) continue;
                const step = [...reach].filter(t => t !== army.tile).sort((a, b) => a - b)[0];
                if (step !== undefined) { try { armies.move(army.id, step); } catch (e) {} }
            }
            // стройка/снос на первой клетке, где что-то доступно
            const build = generator.landTiles.find(i => generator.tileFaction[i] === faction.id
                && construction.actions(faction.id, i).some(a => a.ok));
            if (build !== undefined) {
                const action = construction.actions(faction.id, build).find(a => a.ok);
                try { action.action === 'build' ? construction.build(faction.id, action.type, build) : construction.demolish(faction.id, build); } catch (e) {}
            }
        }
        // дипломатия: игрок-фракция делает ход в сторону соседа
        const player = factions.playerFaction;
        if (player) {
            const other = generator.factions.find(f => f.id !== player.id);
            if (other) { try { diplomacy.perform(player.id, other.id, 'gift'); } catch (e) {} }
        }
    };

    for (let t = 1; t <= 6; t++) {
        turns.advance(1);
        order();
        hashes['turn-' + t] = __hash(snapshot());
    }
    return hashes;
}
`;

function load() {
    const sandbox = { console, Math, Date, JSON };
    const ctx = vm.createContext(sandbox);
    for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
    // MAP_TEST (только хешер) — из tools/map-test.html, единый источник правды.
    const html = fs.readFileSync(path.join(__dirname, 'map-test.html'), 'utf8');
    const start = html.indexOf('const MAP_TEST = (() => {');
    const end = html.indexOf('\n})();', start);
    vm.runInContext(html.slice(start, end + '\n})();'.length) + '\n;globalThis.MAP_TEST = MAP_TEST;', ctx, { filename: 'MAP_TEST' });
    vm.runInContext(DRIVER + '\n;globalThis.__runSim = __runSim;', ctx, { filename: 'sim-driver' });
    return ctx;
}

function run() {
    const ctx = load();
    return ctx.__runSim();
}

function save() {
    const cases = run();
    fs.writeFileSync(BASELINE, JSON.stringify({ version: 1, cases }, null, 1) + '\n');
    console.log(`эталон записан: ${Object.keys(cases).length} шагов -> ${path.relative(ROOT, BASELINE)}`);
}

function check() {
    if (!fs.existsSync(BASELINE)) { console.error('нет эталона — сначала node tools/sim-baseline.js save'); process.exit(2); }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).cases;
    const cases = run();
    const changed = [], missing = [], added = [];
    for (const [name, hash] of Object.entries(baseline)) {
        if (!(name in cases)) missing.push(name);
        else if (cases[name] !== hash) changed.push(name);
    }
    for (const name of Object.keys(cases)) if (!(name in baseline)) added.push(name);
    if (!changed.length && !missing.length && !added.length) {
        console.log(`OK: ${Object.keys(cases).length} шагов совпали с эталоном`);
        return;
    }
    if (changed.length) console.log('ИЗМЕНИЛОСЬ:\n  ' + changed.join('\n  '));
    if (missing.length) console.log('ПРОПАЛО:\n  ' + missing.join('\n  '));
    if (added.length) console.log('ДОБАВИЛОСЬ:\n  ' + added.join('\n  '));
    process.exit(1);
}

const mode = process.argv[2] || 'check';
if (mode === 'save') save();
else if (mode === 'check') check();
else { console.error('использование: node tools/sim-baseline.js [save|check]'); process.exit(2); }
