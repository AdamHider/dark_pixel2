/* ============================================================
   SECTION: SELECTION_VIEW
   Окно выделения: карточки региона и клетки, передача региона, приказы постройки и эдикты.

   Раньше это жило в main.js (секции SELECTION и CONSTRUCTION). Клик по карте
   приходит событием 'select' из game.js, изменение строений — 'construction:change'.

   Подключение: const view = new SelectionView(); view.setup({ game, ui, armyView, notify });
   ============================================================ */

// Подписи для интерфейса (используются карточками клетки/региона и панелью фракций).
const TERRAIN_NAMES = ['глубокая вода', 'мелководье', 'равнина', 'гора'];
const BIOME_NAMES = ['тундра', 'тайга', 'равнина', 'степь', 'пустыня', 'саванна'];
const RESOURCE_NAMES = ['', 'дерево', 'угодья', 'золотая руда', 'эфир', 'железная руда', 'поселение'];
const CROSSING_NAMES = ['', 'мост', 'мост'];

function temperatureName(t) {
    if (t < 0.25) return 'холодно';
    if (t < 0.5) return 'прохладно';
    if (t < 0.75) return 'тепло';
    return 'жарко';
}

class SelectionView extends ViewModule {
    setup({ game, ui, armyView, notify }) {
        this.game = game;
        this.ui = ui;
        this.armyView = armyView;
        this.notify = notify;
        this.panel = document.getElementById('selection');
        this.ownerControls = document.getElementById('owner-controls');
        this.buildControls = document.getElementById('build-controls');
        this.edictControls = document.getElementById('edict-controls');

        this.listenMany(game, HUD_EVENTS, () => this.refresh());
        this.listen(game, 'select', ({ tile, region }) => this.show(tile, region));
        this.listen(game, 'armies:focus', () => this.refresh());   // фокус армии меняет её карточку в окне
        this.listen(game, 'built', () => this.show(null, null));   // новая карта: выделение сброшено
        return this;
    }

    show(tile, region) {
        const { game, ui, panel, armyView } = this;
        if (!tile) {
            panel.hidden = true;
            panel.replaceChildren();
            this.showOwnerControls(null);
            armyView.showControls(null);
            this.showBuildControls(null);
            this.showEdictControls(null);
            return;
        }

        panel.hidden = false;
        panel.replaceChildren();

        if (region) {
            panel.appendChild(ui.renderRegionCard(region, BIOME_NAMES, RESOURCE_NAMES, id => this.factionName(id), game.generator.factions, game.generator));
        }
        panel.appendChild(ui.renderTileCard(tile, TERRAIN_NAMES, BIOME_NAMES, RESOURCE_NAMES, CROSSING_NAMES, temperatureName));

        this.showOwnerControls(region);
        armyView.showControls(tile);
        this.showBuildControls(tile);
        this.showEdictControls(region);
    }

    // Перерисовать текущее выделение (после хода или приказа).
    refresh() {
        const { game } = this;
        const selected = game.renderer.selection;
        if (!selected) return;
        const tile = game.generator.getTileInfo(selected.tile.x, selected.tile.y);
        this.show(tile, tile && tile.regionId >= 0 ? game.generator.getRegionInfo(tile.regionId) : null);
    }

    factionName(id) {
        return this.game.generator.factions[id] ? this.game.generator.factions[id].name : '—';
    }

    // «Передать регион»: кнопки фракций и освобождение.
    showOwnerControls(region) {
        const { game, ownerControls } = this;
        const { factions, generator } = game;
        ownerControls.replaceChildren();
        if (!region || !factions || generator.factions.length === 0) {
            ownerControls.hidden = true;
            return;
        }
        ownerControls.hidden = false;

        const label = this.ui.addText(ownerControls, 'span', 'Передать регион:');
        label.className = 'label';
        label.style.width = '100%';

        for (const faction of generator.factions) {
            const button = this.ui.addText(ownerControls, 'button', faction.name);
            button.type = 'button';
            button.setAttribute('aria-pressed', region.owner === faction.id);
            button.addEventListener('click', () => factions.claimRegion(faction.id, region.id));
        }
        const release = this.ui.addText(ownerControls, 'button', 'Освободить');
        release.type = 'button';
        release.setAttribute('aria-pressed', region.owner === -1 && Object.keys(region.owners).length === 0);
        release.addEventListener('click', () => factions.releaseRegion(region.id));
    }

    // Кнопки приказов для клетки: что можно построить или снести игроку на ней.
    showBuildControls(tile) {
        const { game, buildControls } = this;
        const { factions, construction } = game;
        const player = factions && factions.playerFaction;
        const index = tile ? tile.y * game.generator.size + tile.x : -1;
        const actions = player && index >= 0 ? construction.actions(player.id, index) : [];
        this.ui.renderBuildControls(buildControls, actions.map(a => ({ ...a, costText: construction.describeCost(a.cost) })), {
            onAction: a => {
                try {
                    if (a.action === 'build') construction.build(player.id, a.type, index);
                    else construction.demolish(player.id, index);
                } catch (error) { this.notify(error.message); }
            }
        });
    }

    // Эдикт региона: выбор из списка (только в регионах, где у игрока есть клетки).
    showEdictControls(region) {
        const { game, edictControls } = this;
        const { factions, economy, construction, generator } = game;
        const player = factions && factions.playerFaction;
        const owns = player && region && generator.tileFaction.some((owner, i) => owner === player.id && generator.regionId[i] === region.id);
        this.ui.renderEdictControls(edictControls, owns ? {
            regionId: region.id, current: economy.edictOf(player.id, region.id) || 'none', edicts: FactionEconomy.edicts,
            costText: construction.describeCost(economy.options.edictChangeCost)
        } : null, {
            onChoose: key => {
                try {
                    economy.setEdict(player.id, region.id, key);
                    this.renderPlayer?.();
                    this.refresh();
                } catch (error) { this.notify(error.message); }
            }
        });
    }
}
