/* ============================================================
   SECTION: MAIN
   Точка входа: собираем игру (game.js) и подключаем к ней модули интерфейса.

   Как всё устроено:
     Game           — фасад (game.js): карта, рендерер, менеджеры и шина событий.
     *-manager.js   — правила: фракции, ход, экономика, строительство, армии, дипломатия.
     ArmyView       — ввод и вид армий (army-view.js).
     FactionView    — панель фракций и дипломатии (faction-view.js).
     PlayerView     — верхняя панель ресурсов, «Моя фракция», «Экономика» (player-view.js).
     TurnView       — ход, сезоны, автоход (turn-view.js).
     SelectionView  — окно выделения, приказы постройки и эдикты (selection-view.js).
     MapRenderer    — показывает карту и сам реагирует на изменения.

   Здесь остаётся только провод: создать игру, связать view-модули между собой
   и подписаться на события шины. Никакой игровой логики и разметки панелей.
   ============================================================ */
const canvas = document.getElementById('map');
const info = document.getElementById('info');      // строки состояния на странице может не быть: сообщения игроку идут через notify()

// Вся игра (карта, рендерер, менеджеры, шина событий) — в game.js; параметры генерации — в Game.DEFAULTS.
// uiRenderer — общий на всю страницу (ui-renderer.js).
const game = new Game(canvas, { size: 120 });
const generator = game.generator;
const renderer = game.renderer;

/* ============================================================
   SECTION: NOTIFY
   Сообщение игроку: всплывающая строка внизу экрана, а если есть #info — и в ней.
   ============================================================ */

let toastTimer = 0;
function notify(text) {
    if (info) info.textContent = text;
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.setAttribute('role', 'status');
        document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

/* ============================================================
   SECTION: WIRING
   Сборка интерфейса: view-модули, их зависимости и подписки на шину игры.
   ============================================================ */

let armyView = null;
let factionView = null;
let playerView = null;
let turnView = null;
let selectionView = null;

function centerOnCapital(faction) {
    const size = generator.size, tileSize = renderer.options.tileSize;
    renderer.centerOn((faction.capitalTile % size + 0.5) * tileSize, (Math.floor(faction.capitalTile / size) + 0.5) * tileSize);
}

function connectUI() {
    factionView = new FactionView().setup({ game, ui: uiRenderer, notify, onCenterCapital: centerOnCapital });
    playerView = new PlayerView().setup({ game, ui: uiRenderer, onCapital: () => centerOnCapital(game.factions.playerFaction) });
    turnView = new TurnView().setup({ game });
    selectionView = new SelectionView().setup({ game, ui: uiRenderer, notify });
    selectionView.renderPlayer = () => playerView.render();   // эдикт меняет экономику: обновляем и окно «Экономика»

    armyView = new ArmyView();
    armyView.setup({
        armies: game.armies, factions: game.factions, generator, renderer, construction: game.construction,
        controls: document.getElementById('army-controls'), info, ui: uiRenderer, notify
    });
    armyView.onChange = () => refreshPanels();
    armyView.onSelection = () => selectionView.refresh();
    selectionView.armyView = armyView;

    // Модули объявляют события в шину (game.js); здесь интерфейс на них подписывается.
    game.on('factions:change', () => { armyView.syncHighlights(); refreshPanels(); });
    game.on('construction:change', () => { armyView.syncObjects(); armyView.syncHighlights(); refreshPanels(); });
    game.on('diplomacy:change', () => factionView.render());
    game.on('turn:end', () => { turnView.refresh(); playerView.checkForecast(); refreshPanels(); });
    game.on('select', ({ tile, region }) => {
        armyView.handleClick(tile);            // фокус и приказы армий (до показа клетки: после хода карточка уже обновлена)
        selectionView.show(tile, region);
    });
    game.on('hover', tile => armyView.handleHover(tile));
    game.on('object:click', object => armyView.handleObjectClick(object));
}

// Обновить все панели интерфейса (после хода, приказа или смены фракций).
function refreshPanels() {
    factionView.render();
    playerView.render();
    selectionView.refresh();
}

/* ============================================================
   SECTION: BUILD
   Новая карта.
   ============================================================ */

const seedInput = document.getElementById('seed');

function buildMap() {
    if (turnView) turnView.stopAuto();
    game.build(Number(seedInput.value) || 1);   // карта, менеджеры, стартовое наполнение и событие 'built' — в game.js

    if (!factionView) connectUI();              // первый раз: создаём view-модули и подписки
    else armyView.attach(generator);            // новая карта: сбросить фокус, спрайты и подсветку

    turnView.refresh();
    refreshPanels();
}

/* ============================================================
   SECTION: BUTTONS
   Кнопки и переключатели карты.
   ============================================================ */

document.getElementById('generate').addEventListener('click', () => {
    seedInput.value = Math.floor(Math.random() * 99999);
    buildMap();
});

seedInput.addEventListener('change', buildMap);

document.getElementById('borders').addEventListener('change', e => renderer.setShowBorders(e.target.checked));
document.getElementById('grid').addEventListener('change', e => renderer.setShowGrid(e.target.checked));
document.getElementById('factions-toggle').addEventListener('change', e => renderer.setShowFactions(e.target.checked));

document.getElementById('fit').addEventListener('click', () => renderer.fitToView());

function toggleButton(id, apply) {
    const button = document.getElementById(id);
    button.addEventListener('click', () => {
        const on = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', on);
        apply(on);
    });
}
toggleButton('mood', on => renderer.setMood(on ? 'dark' : 'light'));
toggleButton('settlements', on => renderer.setShowSettlements(on));

let currentView = 'terrain';   // режим просмотра: 'terrain' | 'temperature' | 'regions' | 'factions'
const viewButtons = document.querySelectorAll('[data-view]');
viewButtons.forEach(button => {
    button.addEventListener('click', () => {
        viewButtons.forEach(other => other.setAttribute('aria-pressed', other === button));
        currentView = button.dataset.view;
        if (currentView === 'factions') {                    // политическая карта целиком в слое фракций: слой должен быть включён
            renderer.setShowFactions(true);
            document.getElementById('factions-toggle').checked = true;
        }
        renderer.setView(currentView);
    });
});

/* ============================================================
   SECTION: DEMO_OBJECTS
   Пример объектов на карте.
   ============================================================ */

// Кнопка ставит на карту деревню, город и армию — просто чтобы показать, как это работает.
// Своё: renderer.setObjects([{ id, config, tile: [x, y], options }]) — формат конфигов описан в sprite-renderer.js.
const demoButton = document.getElementById('demo-objects');
demoButton.addEventListener('click', () => {
    const on = demoButton.getAttribute('aria-pressed') !== 'true';
    demoButton.setAttribute('aria-pressed', on);
    if (!on) {
        armyView.setDemoObjects([]);
        return;
    }

    // Три свободные клетки суши поближе к центру карты.
    const center = generator.size / 2;
    const free = generator.landTiles
        .filter(i => generator.terrain[i] === Terrain.PLAIN && !generator.river[i] && generator.resource[i] === Resource.NONE)
        .sort((a, b) => Math.hypot(a % generator.size - center, Math.floor(a / generator.size) - center)
                      - Math.hypot(b % generator.size - center, Math.floor(b / generator.size) - center));
    const spot = k => [free[k * 6] % generator.size, Math.floor(free[k * 6] / generator.size)];

    armyView.setDemoObjects([
        { id: 'city-1', config: SPRITE_EXAMPLES.city, tile: spot(0), options: { colors: { team: '#c0392b' } } },
        { id: 'village-1', config: SPRITE_EXAMPLES.village, tile: spot(1) },
        { id: 'army-demo', config: SPRITE_EXAMPLES.army, tile: spot(2), options: { colors: { team: '#2e86c1' }, flags: ['marching'] } }
    ]);
});

/* ============================================================
   SECTION: START
   ============================================================ */

// Стартовое состояние переключателей берём из страницы (раньше «Сетка» была отмечена в HTML, но не включалась).
renderer.showGrid = document.getElementById('grid').checked;
renderer.showFactions = document.getElementById('factions-toggle').checked;
renderer.options.autoRepaint = document.getElementById('repaint-each-turn').checked ? true : 'season';

buildMap();
