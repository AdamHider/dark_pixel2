/* ============================================================
   SECTION: MAIN
   Точка входа: создаём карту, рендерер и менеджеры, подключаем кнопки.
   Все параметры генерации можно переопределить здесь (полный список — MapGenerator.DEFAULTS).

   Как всё устроено:
     MapGenerator (generator) — сама карта и только данные. Состояние фракций, хода и экономики ей передают менеджеры.
     FactionManager — кто чем владеет (стартовые фракции, захват и освобождение клеток, сводки по фракциям).
     TurnManager    — ходы и сезоны; за ход прогоняет подключённые фазы (сейчас — экономику).
     EconomyManager — рост лесов и полей, рост поселений, запасы фракций (математика подключается параметром calculate).
     MapRenderer    — показывает карту и сам реагирует на изменения: меняет сезон, перерисовывает карту, рисует границы фракций.
   ============================================================ */
   const generator = new MapGenerator({
    size: 120,
    // shapeVariety: 1,       // 0..1: изрезанность континента (заливы, полуострова)
    // islandDensity: 0.8,    // 0..1: больше островов
    // inlandSeaStrength: 0.5,// внутренние моря
    // aridity: 0.1,          // меньше степей и пустынь
    // waterShare: 0.5,       // больше суши
    // mountainShare: 0.2,    // больше гор
    // riverCount: 30,
    // regionMinSize: 5,
    // regionMaxSize: 8,
});

const canvas = document.getElementById('map');
const renderer = new MapRenderer(canvas, generator);
const info = document.getElementById('info');

/* ============================================================
   SECTION: MANAGERS
   Менеджеры.
   ============================================================ */

const TURNS_PER_SEASON = 3;                         // сколько ходов длится сезон
const START_FACTIONS = [                            // стартовые фракции: regions — сколько регионов (число или [мин, макс])
    { name: 'Красные', color: '#d94a3a', secondaryColor: '#f2d27a', flag: { pattern: 'pale', emblem: 'star' }, regions: [4, 5] },
    { name: 'Синие', color: '#3b6fd4', secondaryColor: '#e8ecf4', flag: { pattern: 'chevron', emblem: 'tower' }, regions: [4, 5] }
];   // secondaryColor и flag можно не указывать: подберутся сами (см. FactionManager.makeFaction)

let factions = null, turns = null, economy = null;  // создаются после первой генерации (см. connectManagers)

function connectManagers() {
    factions = new FactionManager(generator, { factions: START_FACTIONS });
    // Математика экономики — faction-economy.js (из симулятора dpresources.html); контракт функции — в начале economy-manager.js.
    economy = new EconomyManager(generator, { calculate: calculateFactionEconomy, ...FactionEconomy.managerOptions(TURNS_PER_SEASON) });
    turns = new TurnManager(generator, { turnsPerSeason: TURNS_PER_SEASON });   // порядок сезонов — SEASON_ORDER из seasons.js
    turns.addPhase('economy', context => economy.step(context));                 // экономика считается раз в ход

    turns.onTurn(onTurnDone);
    factions.onChange(() => {
        refreshFactionPanel();
        refreshPlayerUI();
        refreshSelection();
    });
}

/* ============================================================
   SECTION: NAMES
   Подписи для интерфейса.
   ============================================================ */

const TERRAIN_NAMES = ['глубокая вода', 'мелководье', 'равнина', 'гора'];
const BIOME_NAMES = ['тундра', 'тайга', 'равнина', 'степь', 'пустыня', 'саванна'];
const RESOURCE_NAMES = ['', 'дерево', 'угодья', 'золотая руда', 'эфир', 'железная руда', 'поселение'];
const CROSSING_NAMES = ['', 'мост', 'мост'];
const INCOME_NAMES = { food: 'еда', production: 'производство', gold: 'золото', population: 'население' };

function temperatureName(t) {
    if (t < 0.25) return 'холодно';
    if (t < 0.5) return 'прохладно';
    if (t < 0.75) return 'тепло';
    return 'жарко';
}

function factionName(id) {
    return generator.factions[id] ? generator.factions[id].name : '—';
}

function describeTile(tile) {
    let kind = TERRAIN_NAMES[tile.terrain];
    if (tile.terrain < Terrain.PLAIN) kind = `${kind}, глубина ${tile.waterDepth}`;
    if (tile.terrain === Terrain.PLAIN) kind = tile.hasRiver ? `река (глубина ${tile.riverLevel})` : BIOME_NAMES[tile.biome];
    if (tile.crossing) kind += `, ${CROSSING_NAMES[tile.crossing]}`;

    const parts = [
        `(${tile.x}, ${tile.y})`, 
        kind, 
        `${temperatureName(tile.temperature)} (${Math.round(tile.temperature * 100)}%)`
    ];
    if (tile.resource !== Resource.NONE && tile.resource !== Resource.SETTLEMENT) parts.push(`ресурс: ${RESOURCE_NAMES[tile.resource]}`);
    if (tile.resource === Resource.WOOD || tile.resource === Resource.WHEAT) parts.push(`рост ${Math.round(tile.growth * 100)}%`);
    if (tile.resource === Resource.SETTLEMENT) parts.push(`население ${tile.population} (уровень ${tile.settlementLevel}, группа из ${tile.settlementGroupSize} кл.)`);
    if (tile.roadLevel > 0) parts.push('дорога');
    if (tile.regionId >= 0) parts.push(`регион #${tile.regionId}, ${tile.regionSize} кв.`);
    if (tile.factionId >= 0) parts.push(`фракция: ${factionName(tile.factionId)}`);
    return parts.join(' * ');
}

function showStats() {
    const landPercent = Math.round(generator.landShare * 100);
    const regions = generator.regionCount;
    const average = (generator.landTiles.length / regions).toFixed(1);
    info.textContent = `Суша: ${landPercent}% · регионов: ${regions} · в среднем ${average} кв. Наведите на квадрат.`;
}

/* ============================================================
   SECTION: TURNS
   Ход.
   ============================================================ */

const turnStatus = document.getElementById('turn-status');
const chipTurn = document.getElementById('chip-turn');
const chipSeason = document.getElementById('chip-season');
const chipYear = document.getElementById('chip-year');
const seasonButtons = document.querySelectorAll('[data-season]');

function refreshTurnStatus() {
    const now = turns.calendar();
    const season = SEASONS[now.season] ? SEASONS[now.season].name : now.season;
    turnStatus.textContent = `Ход ${now.turn} · ${season} (ход сезона ${now.turnInSeason + 1}/${TURNS_PER_SEASON}) · год ${now.year + 1}`;
    chipTurn.textContent = now.turn;
    chipSeason.textContent = season;
    chipYear.textContent = now.year + 1;
    seasonButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.season === now.season));
}

// Конец каждого хода (в том числе когда ходов сыграно сразу несколько).
function onTurnDone() {
    refreshTurnStatus();
    checkForecast();
    refreshFactionPanel();
    refreshPlayerUI();
    refreshSelection();
}

// Сыграть ходы. Ошибка в формуле экономики не должна ронять страницу молча — показываем её и останавливаем автоход.
function playTurns(count) {
    try {
        turns.advance(count);
        turnStatus.hidden = true;
    } catch (error) {
        stopAutoTurns();
        turnStatus.hidden = false;
        turnStatus.textContent = `Ошибка при расчёте хода: ${error.message}`;
        console.error(error);
    }
}

document.getElementById('next-turn').addEventListener('click', () => playTurns(1));

// Кнопки сезонов — «перейти к сезону»: сыграть ходы до его начала (весь расчёт экономики при этом честно проходит).
function turnsUntil(season) {
    if (turns.season === season) return 0;
    const limit = TURNS_PER_SEASON * turns.options.seasons.length;
    for (let k = 1; k <= limit; k++) if (turns.calendar(turns.turn + k).season === season) return k;
    return 0;
}

seasonButtons.forEach(button => {
    button.addEventListener('click', () => playTurns(turnsUntil(button.dataset.season)));
});

// Автоход: следующий ход начинается, когда прошло заданное время после предыдущего (и карта уже перерисована).
const autoButton = document.getElementById('auto-turns');
const autoInterval = document.getElementById('auto-interval');
let autoTimer = null;

function stopAutoTurns() {
    clearTimeout(autoTimer);
    autoTimer = null;
    autoButton.setAttribute('aria-pressed', 'false');
}

function scheduleAutoTurn() {
    autoTimer = setTimeout(() => {
        playTurns(1);
        if (autoTimer !== null) scheduleAutoTurn();
    }, Math.max(0.2, Number(autoInterval.value) || 2) * 1000);
}

autoButton.addEventListener('click', () => {
    if (autoTimer !== null) {
        stopAutoTurns();
        return;
    }
    autoButton.setAttribute('aria-pressed', 'true');
    scheduleAutoTurn();
});

// Полная перерисовка карты тяжёлая: можно перерисовывать после каждого хода (видно рост) или только при смене сезона.
document.getElementById('repaint-each-turn').addEventListener('change', e => {
    renderer.options.autoRepaint = e.target.checked ? true : 'season';
});

/* ============================================================
   SECTION: ACTIONS
   Действия.
   ============================================================ */

const seedInput = document.getElementById('seed');

function buildMap() {
    stopAutoTurns();
    generator.generate(Number(seedInput.value) || 1);

    // Менеджеры: в первый раз создаём, потом только привязываем к новой карте и сбрасываем.
    if (!factions) {
        connectManagers();
    } else {
        factions.attach(generator);
        economy.attach(generator);
        turns.reset();
    }

    renderer.refresh();     // карта рисуется один раз и уже в сезоне, с которого начинается игра
    factions.generate();    // стартовые фракции: слой фракций рисуется поверх готовой карты (без перерисовки самой карты)

    //showStats();
    refreshTurnStatus();
    refreshFactionPanel();
    refreshPlayerUI();
}

renderer.onHover = tile => {
    //if (tile) info.textContent = describeTile(tile);
};

/* ============================================================
   SECTION: FACTIONS
   Панель фракций.
   ============================================================ */

const factionPanel = document.getElementById('factions');
const factionPanelBox = document.getElementById('factions-panel');

function addText(parent, tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
}

function numbersLine(values, names, { signed = false } = {}) {
    return Object.entries(values)
        .filter(([key, value]) => names[key] && Math.abs(value) >= 0.5)
        .map(([key, value]) => `${names[key]} ${signed && value > 0 ? '+' : ''}${Math.round(value)}`)
        .join(' · ');
}

function refreshFactionPanel() {
    factionPanel.replaceChildren();
    if (!factions || generator.factions.length === 0) {
        factionPanelBox.hidden = true;
        return;
    }
    factionPanelBox.hidden = false;

    for (const faction of generator.factions) {
        const summary = factions.getFactionInfo(faction.id);
        const money = economy.getFactionEconomy(faction.id);
        const row = document.createElement('article');
        row.className = 'faction';

        const title = document.createElement('h2');
        title.append(uiRenderer.renderFlag(faction, 24), (faction.player ? ' ★ ' : ' ') + faction.name);
        row.appendChild(title);

        const whole = summary.regions.filter(r => r.full).length;
        addText(row, 'p', `Регионов: ${whole}${summary.regions.length > whole ? ` (+${summary.regions.length - whole} частично)` : ''} · клеток: ${summary.size} · население: ${summary.population} · поселений: ${summary.settlements.length}`);
        const resources = summary.resources
            .map((count, code) => (count > 0 && code !== Resource.NONE && code !== Resource.SETTLEMENT ? `${RESOURCE_NAMES[code]} ${count}` : null))
            .filter(Boolean).join(' · ');
        if (resources) addText(row, 'p', `Ресурсы на земле: ${resources}`);
        const stock = numbersLine(money.stockpile, INCOME_NAMES);
        if (stock) addText(row, 'p', `Запасы: ${stock}`);
        const income = numbersLine(money.income, INCOME_NAMES, { signed: true });
        if (income) addText(row, 'p', `Доход за ход: ${income}`);

        if (!faction.player) {
            const choose = addText(row, 'button', 'Играть за них');
            choose.type = 'button';
            choose.addEventListener('click', () => factions.setPlayerFaction(faction.id));
        }
        if (faction.capitalTile >= 0) {
            const button = addText(row, 'button', 'К столице');
            button.type = 'button';
            button.addEventListener('click', () => centerOnCapital(faction));
        }
        factionPanel.appendChild(row);
    }
}

/* ============================================================
   SECTION: PLAYER
   Моя фракция: верхняя панель ресурсов и окна «Моя фракция» и «Экономика» (контейнеры — из index.html).
   Данные собирает buildPlayerModel, показывает UIRenderer. Прогноз на следующий ход — economy.predict: та же функция
   экономики, что считает ход, но без применения результата.
   ============================================================ */

const resourcesBar = document.getElementById('resources-bar');
const myFactionButton = document.getElementById('btn-my-faction');
const myFactionPanel = document.getElementById('my-faction');
const economyPanel = document.getElementById('economy');

// Ресурсы на земле для окна «Моя фракция»: код ресурса карты, значок, подпись.
const LAND_RESOURCES = [
    [Resource.WHEAT, '🌾', 'Пашни'], [Resource.WOOD, '🌲', 'Лес'], [Resource.IRON, '⛏️', 'Железо'], [Resource.ETHER, '🔮', 'Эфир'], [Resource.GOLD, '🪙', 'Золото']
];

let lastForecast = null;    // { turn, stockpile }: что мы обещали на ход turn — для самопроверки в checkForecast

function centerOnCapital(faction) {
    const size = generator.size, tileSize = renderer.options.tileSize;
    renderer.centerOn((faction.capitalTile % size + 0.5) * tileSize, (Math.floor(faction.capitalTile / size) + 0.5) * tileSize);
}

// Контекст СЛЕДУЮЩЕГО хода: то, что TurnManager передаст в economy.step(), когда ход будет сыгран.
function nextTurnContext() {
    const now = turns.calendar();
    const next = turns.calendar(turns.turn + 1);
    return { ...next, seasonIndex: next.seasonIndex ?? turns.options.seasons.indexOf(next.season), seasonChanged: next.season !== now.season };
}

function buildPlayerModel() {
    const player = factions && economy ? factions.playerFaction : null;
    if (!player) return null;

    const context = nextTurnContext();
    const next = economy.predict(player.id, context);
    const now = economy.getFactionEconomy(player.id);
    const info = factions.getFactionInfo(player.id);
    const rows = FactionEconomy.breakdown(next.report);

    // Население хранится в поселениях на карте, а не в запасах: его изменение — по клеткам прогноза.
    const populationNet = next.tiles.reduce((sum, change) => (change.population === undefined ? sum : sum + change.population - economy.population[change.index]), 0);
    const stocks = { gold: now.stockpile.gold ?? 0, food: now.stockpile.food ?? 0, production: now.stockpile.production ?? 0, population: info.population };
    const nets = { gold: next.delta.gold ?? 0, food: next.delta.food ?? 0, production: next.delta.production ?? 0, population: populationNet };
    const resources = {};
    for (const key of Object.keys(stocks)) resources[key] = { stock: stocks[key], net: nets[key], after: stocks[key] + nets[key], rows: rows ? rows[key] : [] };

    const season = next.report ? next.report.season : { name: '', foodMod: 1 };
    return {
        faction: { id: player.id, name: player.name, color: player.color, secondaryColor: player.secondaryColor, flag: player.flag, capitalTile: player.capitalTile },
        resources, season, holdings: now.holdings,
        territory: { regions: info.regions.filter(r => r.full).length, tiles: info.size, settlements: info.settlements.length },
        land: LAND_RESOURCES.map(([code, icon, name]) => ({ icon, name, count: info.resources[code] || 0 })),
        forecastLabel: `Прогноз на ход ${context.turn}: ${season.name}, еда ×${season.foodMod}`,
        forecast: { turn: context.turn, stockpile: next.stockpile }   // для самопроверки (checkForecast), в интерфейсе не показывается
    };
}

function refreshPlayerUI() {
    const model = buildPlayerModel();
    lastForecast = model ? model.forecast : null;
    uiRenderer.renderResourcesBar(resourcesBar, model);
    uiRenderer.renderMyFactionButton(myFactionButton, model);
    uiRenderer.renderMyFaction(myFactionPanel, model, { onCapital: () => centerOnCapital(factions.playerFaction) });
    uiRenderer.renderEconomy(economyPanel, model);
}

// Самопроверка: после хода запасы игрока должны совпасть с обещанным прогнозом. Расхождение почти наверняка значит, что
// nextTurnContext отдаёт не то, что TurnManager передаёт в step() (другой номер хода или сезон), или формула недетерминирована.
function checkForecast() {
    if (!lastForecast || turns.turn !== lastForecast.turn) return;
    const actual = economy.getPlayerEconomy();
    if (!actual) return;
    const wrong = Object.entries(lastForecast.stockpile).filter(([key, value]) => Math.abs(value - (actual.stockpile[key] ?? 0)) > 0.01);
    if (wrong.length > 0) console.warn('Прогноз экономики не совпал с ходом:', { predicted: lastForecast.stockpile, actual: actual.stockpile });
}

/* ============================================================
   SECTION: SELECTION
   Выделение по клику и детальное отображение через UIRenderer.
   ============================================================ */

    const selectionPanel = document.getElementById('selection');
    const ownerControls = document.getElementById('owner-controls');
    
    function showOwnerControls(region) {
        ownerControls.replaceChildren();
        if (!region || !factions || generator.factions.length === 0) {
            ownerControls.hidden = true;
            return;
        }
        ownerControls.hidden = false;
        
        const label = document.createElement('span');
        label.className = 'label';
        label.style.width = '100%';
        label.textContent = 'Передать регион:';
        ownerControls.appendChild(label);
    
        for (const faction of generator.factions) {
            const button = addText(ownerControls, 'button', faction.name);
            button.type = 'button';
            button.setAttribute('aria-pressed', region.owner === faction.id);
            button.addEventListener('click', () => factions.claimRegion(faction.id, region.id));
        }
        const release = addText(ownerControls, 'button', 'Освободить');
        release.type = 'button';
        release.setAttribute('aria-pressed', region.owner === -1 && Object.keys(region.owners).length === 0);
        release.addEventListener('click', () => factions.releaseRegion(region.id));
    }
   
    function showSelection(tile, region) {
        if (!tile) {
            selectionPanel.hidden = true;
            selectionPanel.replaceChildren();
            showOwnerControls(null);
            return;
        }
        
        selectionPanel.hidden = false;
        selectionPanel.replaceChildren();


        if (region) {
            // Передаем generator в качестве последнего параметра для анализа тайлов
            const regionCardEl = uiRenderer.renderRegionCard(region, BIOME_NAMES, RESOURCE_NAMES, factionName, generator.factions, generator);
            selectionPanel.appendChild(regionCardEl);
        }
        
        const tileCardEl = uiRenderer.renderTileCard(tile, TERRAIN_NAMES, BIOME_NAMES, RESOURCE_NAMES, CROSSING_NAMES, temperatureName);
        selectionPanel.appendChild(tileCardEl);
        
        showOwnerControls(region);
    }
   
    renderer.onSelect = showSelection;
    
    function refreshSelection() {
        const selected = renderer.selection;
        if (!selected) return;
        const tile = generator.getTileInfo(selected.tile.x, selected.tile.y);
        showSelection(tile, tile && tile.regionId >= 0 ? generator.getRegionInfo(tile.regionId) : null);
    }

/* ============================================================
   SECTION: BUTTONS
   Кнопки.
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
        renderer.setObjects([]);
        return;
    }

    // Три свободные клетки суши поближе к центру карты.
    const center = generator.size / 2;
    const free = generator.landTiles
        .filter(i => generator.terrain[i] === Terrain.PLAIN && !generator.river[i] && generator.resource[i] === Resource.NONE)
        .sort((a, b) => Math.hypot(a % generator.size - center, Math.floor(a / generator.size) - center)
                      - Math.hypot(b % generator.size - center, Math.floor(b / generator.size) - center));
    const spot = k => [free[k * 6] % generator.size, Math.floor(free[k * 6] / generator.size)];

    renderer.setObjects([
        { id: 'city-1', config: SPRITE_EXAMPLES.city, tile: spot(0), options: { colors: { team: '#c0392b' } } },
        { id: 'village-1', config: SPRITE_EXAMPLES.village, tile: spot(1) },
        { id: 'army-1', config: SPRITE_EXAMPLES.army, tile: spot(2), options: { colors: { team: '#2e86c1' }, flags: ['marching'] } }
    ]);
});
renderer.onObjectClick = object => {
    info.textContent = `Объект: ${object.id}`;
};

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

const viewButtons = document.querySelectorAll('[data-view]');
viewButtons.forEach(button => {
    button.addEventListener('click', () => {
        viewButtons.forEach(other => other.setAttribute('aria-pressed', other === button));
        renderer.setView(button.dataset.view);
    });
});

// Стартовое состояние переключателей берём из страницы (раньше «Сетка» была отмечена в HTML, но не включалась).
renderer.showGrid = document.getElementById('grid').checked;
renderer.showFactions = document.getElementById('factions-toggle').checked;
renderer.options.autoRepaint = document.getElementById('repaint-each-turn').checked ? true : 'season';

buildMap();