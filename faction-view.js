/* ============================================================
   SECTION: FACTION_VIEW
   Панель «Дипломатия и Фракции»: сводка по каждой фракции, отношения и действия.

   Раньше это жило в main.js (секция FACTIONS). Модуль только читает состояние
   менеджеров (FactionManager, EconomyManager, DiplomacyManager) и рисует DOM;
   изменения приходят событием 'factions:change' / 'diplomacy:change' из game.js.

   Подключение: const view = new FactionView(); view.setup({ game, ui, notify, onCenterCapital });
   ============================================================ */

const FACTION_VIEW = {
    RELATION_LINE_NAMES: { war: 'красная', peace: 'белая', alliance: 'зелёная' },
    RELATION_NAMES: { war: 'война', peace: 'нейтралитет', alliance: 'союз' },   // peace показывается как нейтралитет: на границе его линия белая
    INCOME_NAMES: { production: 'производство', gold: 'золото', population: 'население' }   // еда — не запас и не доход, а уровень (см. FactionEconomy.foodTier)
};

class FactionView {
    setup({ game, ui, notify, onCenterCapital }) {
        this.game = game;
        this.ui = ui;
        this.notify = notify;
        this.onCenterCapital = onCenterCapital;
        this.panel = document.getElementById('factions');
        this.panelBox = document.getElementById('factions-panel');
        this.log = document.getElementById('diplomacy-log');
        return this;
    }

    // Строка вида «производство +12 · золото +1»: только значимые (>= 0.5) значения.
    numbersLine(values, names, { signed = false } = {}) {
        return Object.entries(values)
            .filter(([key, value]) => names[key] && Math.abs(value) >= 0.5)
            .map(([key, value]) => `${names[key]} ${signed && value > 0 ? '+' : ''}${Math.round(value)}`)
            .join(' · ');
    }

    render() {
        const { game, ui, panel, panelBox } = this;
        const { factions, economy, diplomacy } = game;
        panel.replaceChildren();
        if (!factions || game.generator.factions.length === 0) {
            panelBox.hidden = true;
            return;
        }
        panelBox.hidden = false;

        for (const faction of game.generator.factions) {
            const summary = factions.getFactionInfo(faction.id);
            const money = economy.getFactionEconomy(faction.id);
            const row = document.createElement('article');
            row.className = 'faction';

            const title = document.createElement('h2');
            title.append(ui.renderFlag(faction, 24), (faction.player ? ' ★ ' : ' ') + faction.name);
            row.appendChild(title);

            const whole = summary.regions.filter(r => r.full).length;
            ui.addText(row, 'p', `Регионов: ${whole}${summary.regions.length > whole ? ` (+${summary.regions.length - whole} частично)` : ''} · клеток: ${summary.size} · население: ${summary.population} · поселений: ${summary.settlements.length}`);
            const resources = summary.resources
                .map((count, code) => (count > 0 && code !== Resource.NONE && code !== Resource.SETTLEMENT ? `${RESOURCE_NAMES[code]} ${count}` : null))
                .filter(Boolean).join(' · ');
            if (resources) ui.addText(row, 'p', `Ресурсы на земле: ${resources}`);
            const stock = this.numbersLine(money.stockpile, FACTION_VIEW.INCOME_NAMES);
            if (stock) ui.addText(row, 'p', `Запасы: ${stock}`);
            const foodLevel = money.conditions.food ?? 0;
            ui.addText(row, 'p', `Продовольствие: ${ui.formatLevel(foodLevel)} · ${FactionEconomy.foodTier(foodLevel).name}`);
            const income = this.numbersLine(money.income, FACTION_VIEW.INCOME_NAMES, { signed: true });
            if (income) ui.addText(row, 'p', `Доход за ход: ${income}`);

            const player = factions.playerFaction;
            if (player && faction.id !== player.id) {
                const state = factions.relationOf(player.id, faction.id);
                const opinion = diplomacy.opinion(player.id, faction.id);
                row.appendChild(ui.renderOpinion(opinion, diplomacy.tier(opinion), `${FACTION_VIEW.RELATION_NAMES[state]} · линия ${FACTION_VIEW.RELATION_LINE_NAMES[state]}`));
                row.appendChild(ui.renderDiplomacyActions(diplomacy.actions(player.id, faction.id), {
                    onAction: action => {
                        try {
                            const result = diplomacy.perform(player.id, faction.id, action.action);
                            if (result.accepted === false) this.notify(`${faction.name} отклоняет предложение`);
                        } catch (error) { this.notify(error.message); }
                    }
                }));
            }
            if (!faction.player) {
                const choose = ui.addText(row, 'button', 'Играть за них');
                choose.type = 'button';
                choose.addEventListener('click', () => factions.setPlayerFaction(faction.id));
            }
            if (faction.capitalTile >= 0) {
                const button = ui.addText(row, 'button', 'К столице');
                button.type = 'button';
                button.addEventListener('click', () => this.onCenterCapital(faction));
            }
            panel.appendChild(row);
        }
        ui.renderDiplomacyLog(this.log, diplomacy.log);
    }
}
