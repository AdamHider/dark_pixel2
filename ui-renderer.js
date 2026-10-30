/* ============================================================
   UI RENDERER (Двухуровневая система биомов и надстроек)
   ============================================================ */

// Словари названий и прилагательных для красивой сборки названий
const BASE_BIOME_NAMES = {
    'plains': { name: 'Равнина', adj: 'Равнинные' },
    'snow_plains': { name: 'Заснеженная равнина', adj: 'Заснеженные' },
    'tundra': { name: 'Тундра', adj: 'Тундровые' },
    'taiga': { name: 'Тайга', adj: 'Таёжные' },
    'steppe': { name: 'Степь', adj: 'Степные' },
    'desert': { name: 'Пустыня', adj: 'Пустынные' },
    'savanna': { name: 'Саванна', adj: 'Саванные' }
};

const MODIFIER_NAMES = {
    'flat': '', // Без надстройки (просто базовый биом)
    'farmland': 'плодородные земли',
    'forest': 'густой лес',
    'woodland': 'роща / редколесье',
    'hills': 'холмы',
    'mountains': 'горные массивы',
    'oasis': 'оазис / водоём'
};

// Ресурсы экономики: порядок показа в верхней панели и в окне «Экономика».
const ECONOMY_RESOURCES = [
    { key: 'gold', icon: '🪙', name: 'Золото', title: 'Золото (казна)' },
    { key: 'food', icon: '🌾', name: 'Еда', title: 'Еда (зернохранилище)' },
    { key: 'production', icon: '⚙️', name: 'Производство', title: 'Производство (склад)' },
    { key: 'population', icon: '👥', name: 'Население', title: 'Население' }
];

// Узор флага: фигура второго цвета на поле основного (флаг 30×20).
const FLAG_PATTERNS = {
    solid: () => '',
    pale: c => `<rect x="15" width="15" height="20" fill="${c}"/>`,
    fess: c => `<rect y="10" width="30" height="10" fill="${c}"/>`,
    bend: c => `<polygon points="0,0 9,0 30,15 30,20 21,20 0,5" fill="${c}"/>`,
    cross: c => `<rect x="11" width="6" height="20" fill="${c}"/><rect y="7" width="30" height="6" fill="${c}"/>`,
    saltire: c => `<path d="M0 0L30 20M30 0L0 20" stroke="${c}" stroke-width="4"/>`,
    chevron: c => `<polygon points="0,20 15,5 30,20 30,14 15,-1 0,14" fill="${c}"/>`,
    stripes: c => `<rect y="4" width="30" height="4" fill="${c}"/><rect y="12" width="30" height="4" fill="${c}"/>`
};

// Эмблема флага по центру: второго цвета, с тёмным контуром (читается на любом фоне).
const FLAG_EMBLEMS = {
    none: '',
    star: '<polygon points="15,5.5 16.9,9.3 21,9.9 18,12.8 18.7,17 15,15 11.3,17 12,12.8 9,9.9 13.1,9.3"/>',
    circle: '<circle cx="15" cy="10" r="3.6"/>',
    diamond: '<polygon points="15,5.5 19.5,10 15,14.5 10.5,10"/>',
    cross: '<polygon points="13.6,5.5 16.4,5.5 16.4,8.6 19.5,8.6 19.5,11.4 16.4,11.4 16.4,14.5 13.6,14.5 13.6,11.4 10.5,11.4 10.5,8.6 13.6,8.6"/>',
    tower: '<path d="M11.5 15.5V7.5h1.7v1.6h1.2V7.5h1.2v1.6h1.2V7.5h1.7v8z"/>'
};

class UIRenderer {
    constructor() {}

    createElement(tag, className = '', attributes = {}, children = []) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'text') el.textContent = value;
            else if (key === 'html') el.innerHTML = value;
            else el.setAttribute(key, value);
        }

        children.forEach(child => {
            if (child) el.appendChild(child);
        });

        return el;
    }

    // Двухуровневый анализ региона: Базовый биом + Надстройка
    getRegionBiomeData(region, generator) {
        const totalTiles = region.size || 1;
        
        // 1. ОПРЕДЕЛЕНИЕ БАЗОВОГО БИОМА
        const dominantBiomeIndex = region.biomes.indexOf(Math.max(...region.biomes));
        let baseBiome = ['tundra', 'taiga', 'plains', 'steppe', 'desert', 'savanna'][dominantBiomeIndex] || 'plains';

        // Подсчёт параметров региона
        let woodCount = 0;
        let wheatCount = 0;
        let mountainCount = region.mountains || 0;
        let riverCount = region.riverTiles || 0;
        let totalTemp = 0;

        if (region.tiles && region.tiles.length > 0) {
            region.tiles.forEach(tileIdx => {
                const terrain = generator.terrain[tileIdx];
                const resource = generator.resource[tileIdx];
                const temp = generator.temperature ? generator.temperature[tileIdx] : 0.5;

                totalTemp += temp;
                if (terrain === 3) mountainCount++; // Terrain.MOUNTAIN
                if (resource === 1) woodCount++;    // Resource.WOOD
                if (resource === 2) wheatCount++;   // Resource.WHEAT
            });
        } else if (region.resources) {
            woodCount = region.resources[1] || 0;
            wheatCount = region.resources[2] || 0;
        }

        const avgTemp = totalTemp / totalTiles;
        const woodRatio = woodCount / totalTiles;
        const wheatRatio = wheatCount / totalTiles;
        const mountainRatio = mountainCount / totalTiles;
        const hasRiver = riverCount > (totalTiles * 0.15);

        // Уточнение заснеженных равнин по низкой температуре
        if (baseBiome === 'plains' && avgTemp < 0.35) {
            baseBiome = 'tundra';
        }

        // 2. ОПРЕДЕЛЕНИЕ НАДСТРОЙКИ (МОДИФИКАТОРА)
        let modifier = 'flat';

        if (mountainRatio > 0.35) {
            modifier = 'mountains';
        } else if (mountainRatio > 0.12) {
            modifier = 'hills';
        } else if (woodRatio > 0.35) {
            modifier = 'forest';
        } else if (woodRatio > 0.12) {
            modifier = 'woodland';
        } else if (wheatRatio > 0.08) {
            modifier = 'farmland';
        } else if (hasRiver && (baseBiome === 'desert' || baseBiome === 'steppe')) {
            modifier = 'oasis';
        }

        // 3. СБОРКА ИТОГОВОГО НАЗВАНИЯ И ФАЙЛА ИЗОБРАЖЕНИЯ
        const baseData = BASE_BIOME_NAMES[baseBiome] || BASE_BIOME_NAMES['plains'];
        const modTitle = MODIFIER_NAMES[modifier];

        let displayName = baseData.name;
        if (modTitle) {
            displayName = `${baseData.adj} ${modTitle}`;
        }

        // Ключ картинки: 'desert_farmland', 'steppe_hills', 'tundra_forest' или просто 'desert'
        const imageKey = modifier !== 'flat' ? `${baseBiome}_${modifier}` : baseBiome;

        return {
            baseBiome,
            modifier,
            displayName,
            imageKey,
            imagePath: `img/regions/${imageKey}.png`
        };
    }

    renderRegionCard(region, biomeNames, resourceNames, factionNameFn, factionsList, generator) {
        // Получаем сведённые данные о биоме
        const biomeData = this.getRegionBiomeData(region, generator);
        const biomeClass = this.getBiomeBadgeClass(biomeData.baseBiome);

        // Подсчёт базовых ресурсов
        let goldCount = 0, foodCount = 0, productionCount = 0;
        let populationCount = region.population || 0;

        if (region.resources) {
            region.resources.forEach((count, code) => {
                if (!count || count <= 0) return;
                const resName = resourceNames[code] ? resourceNames[code].toLowerCase() : '';
                if (resName.includes('золот') || code === 3) goldCount += count;
                if (resName.includes('ед') || resName.includes('дерев') || code === 1 || code === 2) foodCount += count;
                if (resName.includes('производ') || resName.includes('желез') || code === 5) productionCount += count;
            });
        }

        // Определение владельца
        let ownerElement;
        if (region.owner >= 0 && factionsList[region.owner]) {
            const faction = factionsList[region.owner];
            ownerElement = this.createElement('span', 'owner-badge', {
                style: `border-color: ${faction.color}; color: ${faction.color};`,
                text: `👑 ${faction.name}`
            });
        } else if (Object.keys(region.owners).length > 0) {
            const parts = Object.entries(region.owners).map(([id, n]) => `${factionNameFn(Number(id))} (${n} кл.)`);
            ownerElement = this.createElement('span', 'owner-partial', { text: `Оспаривается: ${parts.join(', ')}` });
        } else {
            ownerElement = this.createElement('span', 'owner-neutral', { text: 'Нейтральная территория' });
        }

        // Рендер баннера с фоном и собранным составным названием
        const bannerEl = this.createElement('div', 'region-banner', {
            style: `background-image: url('${biomeData.imagePath}');`
        }, [
            this.createElement('div', 'region-banner-overlay'),
            this.createElement('span', `biome-badge ${biomeClass}`, { text: biomeData.displayName })
        ]);

        const statsGrid = this.createElement('div', 'region-stats-grid', {}, [
            this.createStatBox(`🪙 ${goldCount}`, 'Золото'),
            this.createStatBox(`🌾 ${foodCount}`, 'Еда'),
            this.createStatBox(`⚙️ ${productionCount}`, 'Производ.'),
            this.createStatBox(`👥 ${populationCount}`, 'Население')
        ]);

        const resourcesSection = this.createElement('div', 'region-resources-section', {}, [
            this.createElement('div', 'section-subtitle', { text: 'Ресурсы региона' }),
            statsGrid
        ]);

        const metaInfo = this.createElement('div', 'region-meta-info', {}, [
            this.createElement('span', {}, { html: `<b>Площадь:</b> ${region.size} кв.` }),
            this.createElement('span', {}, { html: `<b>Горы:</b> ${region.mountains} кл.` }),
            this.createElement('span', {}, { html: `<b>Реки:</b> ${region.riverTiles} кл.` })
        ]);
        if (region.coastal) {
            metaInfo.appendChild(this.createElement('span', 'feature-tag', { text: '🌊 Выход к морю' }));
        }

        const detailsSection = this.createElement('div', 'region-details-section', {}, [
            this.createElement('div', 'section-subtitle', { text: 'Характеристики территории' }),
            metaInfo
        ]);

        return this.createElement('div', 'region-card', {}, [
            bannerEl,
            this.createElement('div', 'region-card-header', {}, [
                this.createElement('div', 'region-title-row', {}, [
                    this.createElement('span', 'region-id', { text: `Регион #${region.id}` }),
                    ownerElement
                ])
            ]),
            resourcesSection,
            detailsSection
        ]);
    }

    createStatBox(numText, subText) {
        return this.createElement('div', 'stat-box', {}, [
            this.createElement('span', 'stat-num', { text: numText }),
            this.createElement('span', 'stat-sub', { text: subText })
        ]);
    }

    renderTileCard(tile, terrainNames, biomeNames, resourceNames, crossingNames, temperatureName) {
        let kind = terrainNames[tile.terrain];
        if (tile.terrain < 2) {
            kind = `${kind} (глубина ${tile.waterDepth})`;
        } else if (tile.terrain === 2) {
            kind = tile.hasRiver ? `Река (глубина ${tile.riverLevel})` : biomeNames[tile.biome];
        }
        if (tile.crossing) kind += `, ${crossingNames[tile.crossing]}`;
       
        const statsGrid = this.createElement('div', 'tile-stats-grid', {}, [
            this.createElement('div', 'stat-item', { html: `<span class="stat-label">Климат</span><span class="stat-val">${temperatureName(tile.temperature)} (${this.getTemperature(tile.temperature)}°C)</span>` })
        ]);

        if (tile.resource !== 0 && tile.resource !== 6) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Ресурс</span><span class="stat-val highlight">${resourceNames[tile.resource]}</span>` }));
        }
        if (tile.resource === 6) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Поселение</span><span class="stat-val">${tile.population} чел. (ур. ${tile.settlementLevel})</span>` }));
        }
        if (tile.roadLevel > 0) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Инфраструктура</span><span class="stat-val">Дорога</span>` }));
        }

        return this.createElement('div', 'tile-card', {}, [
            this.createElement('div', 'tile-card-header', {}, [
                this.createElement('span', 'tile-coords', { text: `📍 Клетка (${tile.x}, ${tile.y})` }),
                this.createElement('span', 'tile-kind', { text: kind })
            ]),
            statsGrid
        ]);
    }

    getTemperature(val, minTemp = -20, maxTemp = 40) {
        const clamped = Math.max(0, Math.min(1, val));
        return Math.round(minTemp + clamped * (maxTemp - minTemp));
    }

    getBiomeBadgeClass(biomeName) {
        switch (biomeName) {
            case 'tundra': return 'biome-tundra';
            case 'taiga': return 'biome-taiga';
            case 'plains': return 'biome-plains';
            case 'snow_plains': return 'biome-tundra';
            case 'steppe': return 'biome-steppe';
            case 'desert': return 'biome-desert';
            case 'savanna': return 'biome-savanna';
            default: return '';
        }
    }

    /* ============================================================
       SECTION: PLAYER_PANEL
       Верхняя панель ресурсов, окна «Моя фракция» и «Экономика»: наполняют готовые контейнеры из index.html.
       Здесь только показ: данные (model) собирает main.js (buildPlayerModel), UIRenderer ничего не считает.
       model = {
           faction: { id, name, color, secondaryColor, flag, capitalTile },
           resources: { gold|food|production|population: { stock, net, after, rows: [{ label, value }] } },
           season: { name, foodMod }, holdings: { army, towers },
           territory: { regions, tiles, settlements }, land: [{ icon, name, count }],
           forecastLabel
       }
       ============================================================ */

    // Число для интерфейса: до 10 — с десятой, дальше целое; signed — с «+» у положительных.
    formatAmount(value, { signed = false } = {}) {
        const rounded = (Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value)) || 0;   // «|| 0» убирает -0
        const text = rounded.toLocaleString('ru-RU');
        return signed && rounded > 0 ? `+${text}` : text;
    }

    deltaClass(value) {
        return value > 0.05 ? 'pos' : value < -0.05 ? 'neg' : 'zero';
    }

    // Цвет из данных вставляем в разметку только если это «#rgb» или «#rrggbb».
    safeColor(color, fallback) {
        return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color || '') ? color : fallback;
    }

    // Флаг фракции (SVG 3:2): поле основного цвета, узор и эмблема второго цвета.
    renderFlag(faction, width = 30) {
        const primary = this.safeColor(faction.color, '#999999');
        const secondary = this.safeColor(faction.secondaryColor, '#dddddd');
        const flag = faction.flag || {};
        const pattern = (FLAG_PATTERNS[flag.pattern] || FLAG_PATTERNS.solid)(secondary);
        const emblem = FLAG_EMBLEMS[flag.emblem] || '';
        const svg = `<svg viewBox="0 0 30 20" width="${width}" height="${Math.round(width * 2 / 3)}" aria-hidden="true">`
            + `<rect width="30" height="20" fill="${primary}"/>${pattern}`
            + (emblem ? `<g fill="${secondary}" stroke="rgba(0,0,0,.6)" stroke-width=".7" stroke-linejoin="round">${emblem}</g>` : '')
            + '<rect width="30" height="20" fill="none" stroke="rgba(0,0,0,.75)" stroke-width="1.2"/></svg>';
        return this.createElement('span', 'flag', { html: svg, title: faction.name });
    }

    // Верхняя панель: запас каждого ресурса и изменение на следующий ход, например «🌾 41 (+28)».
    renderResourcesBar(container, model) {
        container.replaceChildren();
        container.hidden = !model;
        if (!model) return;
        for (const resource of ECONOMY_RESOURCES) {
            const { stock, net, after } = model.resources[resource.key];
            container.appendChild(this.createElement('div', 'res-item', {
                title: `${resource.title}: ${this.formatAmount(stock)}. Прогноз на следующий ход: ${this.formatAmount(net, { signed: true })} → ${this.formatAmount(after)}`
            }, [
                this.createElement('span', 'icon', { text: resource.icon }),
                this.createElement('span', 'val', { text: this.formatAmount(stock) }),
                this.createElement('span', `delta ${this.deltaClass(net)}`, { text: this.formatAmount(net, { signed: true }) })
            ]));
        }
    }

    // Кнопка «Моя фракция» в шапке: флаг рядом с названием.
    renderMyFactionButton(button, model) {
        for (const old of button.querySelectorAll('.flag')) old.remove();
        if (model) button.prepend(this.renderFlag(model.faction, 20));
    }

    // Окно «Моя фракция»: флаг и цвета, территория, армии и башни, ресурсы на земле.
    renderMyFaction(container, model, { onCapital } = {}) {
        container.replaceChildren();
        if (!model) {
            container.appendChild(this.createElement('div', 'placeholder-box', { text: 'Фракция игрока не выбрана' }));
            return;
        }
        const faction = model.faction;
        const swatch = (color, text) => this.createElement('span', 'color-chip', {}, [
            this.createElement('span', 'swatch', { style: `background: ${this.safeColor(color, '#999999')};` }),
            this.createElement('span', '', { text })
        ]);
        const head = this.createElement('div', 'my-faction-head', {}, [
            this.renderFlag(faction, 72),
            this.createElement('div', 'my-faction-title', {}, [
                this.createElement('div', 'my-faction-name', { text: faction.name }),
                this.createElement('div', 'my-faction-colors', {}, [swatch(faction.color, 'основной'), swatch(faction.secondaryColor, 'второй')])
            ])
        ]);

        const row = (label, value) => this.createElement('div', 'kv-row', {}, [this.createElement('span', '', { text: label }), this.createElement('b', '', { text: value })]);
        const territory = this.createElement('div', 'kv-list', {}, [
            row('Регионов', String(model.territory.regions)), row('Клеток', String(model.territory.tiles)), row('Поселений', String(model.territory.settlements)),
            row('Население', this.formatAmount(model.resources.population.stock)),
            row('Армий', String(model.holdings.army)), row('Башен', String(model.holdings.towers))
        ]);

        const land = this.createElement('div', 'region-stats-grid', {}, model.land.map(item => this.createStatBox(`${item.icon} ${item.count}`, item.name)));

        container.append(head,
            this.createElement('div', 'section-subtitle', { text: 'Территория' }), territory,
            this.createElement('div', 'section-subtitle', { text: 'Ресурсы на земле' }), land);
        if (faction.capitalTile >= 0 && onCapital) {
            const button = this.createElement('button', '', { type: 'button', text: 'К столице' });
            button.addEventListener('click', onCapital);
            container.appendChild(this.createElement('div', 'group', {}, [button]));
        }
    }

    // Окно «Экономика»: по каждому ресурсу запас и прогноз на следующий ход («40 (+2 → 42)») и раскрывающаяся разбивка прихода и расхода.
    renderEconomy(container, model) {
        const opened = new Set([...container.querySelectorAll('details[open]')].map(d => d.dataset.key));   // раскрытые разбивки переживают перерисовку
        container.replaceChildren();
        if (!model) {
            container.appendChild(this.createElement('div', 'placeholder-box', { text: 'Фракция игрока не выбрана' }));
            return;
        }
        container.appendChild(this.createElement('div', 'eco-season', { text: model.forecastLabel }));

        for (const resource of ECONOMY_RESOURCES) {
            const { stock, net, after, rows } = model.resources[resource.key];
            const details = this.createElement('details', 'eco-details', { 'data-key': resource.key }, [
                this.createElement('summary', '', { text: 'Приход и расход' }),
                ...rows.map(r => this.createElement('div', 'eco-row', {}, [
                    this.createElement('span', '', { text: r.label }),
                    this.createElement('b', this.deltaClass(r.value), { text: this.formatAmount(r.value, { signed: true }) })
                ]))
            ]);
            details.open = opened.has(resource.key);
            container.appendChild(this.createElement('div', `eco-box eco-${resource.key}`, {}, [
                this.createElement('div', 'eco-title', {}, [
                    this.createElement('span', '', { text: `${resource.icon} ${resource.title}` }),
                    this.createElement('span', 'eco-value', {}, [
                        this.createElement('span', '', { text: this.formatAmount(stock) }),
                        this.createElement('span', `delta ${this.deltaClass(net)}`, { text: `(${this.formatAmount(net, { signed: true })} → ${this.formatAmount(after)})` })
                    ])
                ]),
                details
            ]));
        }
        container.appendChild(this.createElement('div', 'eco-note', { text: `Армий: ${model.holdings.army} · Башен: ${model.holdings.towers}` }));
    }
}

const uiRenderer = new UIRenderer();