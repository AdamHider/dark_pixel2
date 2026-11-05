/* ============================================================
   SECTION: TURN_VIEW
   Ход: строка состояния, кнопки сезонов, «Следующий ход» и автоход.

   Раньше это жило в main.js (секция TURNS). Ход играет TurnManager (game.turn);
   здесь только DOM и таймеры. Конец хода приходит событием 'turn:end' из game.js —
   main.js на него подписывается и обновляет панели.

   Подключение: const view = new TurnView(); view.setup({ game, onError });
   ============================================================ */

class TurnView {
    setup({ game, onError }) {
        this.game = game;
        this.onError = onError;
        this.status = document.getElementById('turn-status');
        this.chipTurn = document.getElementById('chip-turn');
        this.chipSeason = document.getElementById('chip-season');
        this.chipYear = document.getElementById('chip-year');
        this.seasonButtons = document.querySelectorAll('[data-season]');
        this.autoButton = document.getElementById('auto-turns');
        this.autoInterval = document.getElementById('auto-interval');
        this.autoTimer = null;
        this.bind();
        return this;
    }

    bind() {
        const { game } = this;
        document.getElementById('next-turn').addEventListener('click', () => this.play(1));
        this.seasonButtons.forEach(button => button.addEventListener('click', () => this.play(this.until(button.dataset.season))));

        this.autoButton.addEventListener('click', () => {
            if (this.autoTimer !== null) { this.stopAuto(); return; }
            this.autoButton.setAttribute('aria-pressed', 'true');
            this.schedule();
        });

        // Полная перерисовка карты тяжёлая: можно перерисовывать после каждого хода (видно рост) или только при смене сезона.
        document.getElementById('repaint-each-turn').addEventListener('change', e => {
            game.renderer.options.autoRepaint = e.target.checked ? true : 'season';
        });
    }

    refresh() {
        const { game } = this;
        const now = game.turns.calendar();
        const season = SEASONS[now.season] ? SEASONS[now.season].name : now.season;
        this.status.textContent = `Ход ${now.turn} · ${season} (ход сезона ${now.turnInSeason + 1}/${game.options.turnsPerSeason}) · год ${now.year + 1}`;
        this.chipTurn.textContent = now.turn;
        this.chipSeason.textContent = season;
        this.chipYear.textContent = now.year + 1;
        this.seasonButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.season === now.season));
    }

    // Сыграть ходы. Ошибка в формуле экономики не должна ронять страницу молча — показываем её и останавливаем автоход.
    play(count) {
        try {
            this.game.turn(count);
            this.status.hidden = true;
        } catch (error) {
            this.stopAuto();
            this.status.hidden = false;
            this.status.textContent = `Ошибка при расчёте хода: ${error.message}`;
            console.error(error);
        }
    }

    // «Перейти к сезону»: сыграть ходы до его начала (весь расчёт экономики при этом честно проходит).
    until(season) {
        const { turns } = this.game;
        if (turns.season === season) return 0;
        const limit = this.game.options.turnsPerSeason * turns.options.seasons.length;
        for (let k = 1; k <= limit; k++) if (turns.calendar(turns.turn + k).season === season) return k;
        return 0;
    }

    stopAuto() {
        clearTimeout(this.autoTimer);
        this.autoTimer = null;
        this.autoButton.setAttribute('aria-pressed', 'false');
    }

    // Следующий ход начинается, когда прошло заданное время после предыдущего (и карта уже перерисована).
    schedule() {
        this.autoTimer = setTimeout(() => {
            this.play(1);
            if (this.autoTimer !== null) this.schedule();
        }, Math.max(0.2, Number(this.autoInterval.value) || 2) * 1000);
    }
}
