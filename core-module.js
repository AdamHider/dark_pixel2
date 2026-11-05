/* ============================================================
   SECTION: GAME_MODULE
   База для менеджеров игры.

   Раньше каждый менеджер заводил свой listeners, onChange и emit — один и
   тот же код в шести файлах. Теперь это здесь. GameModule отвечает только
   за связь с картой и уведомление подписчиков; правила и данные — в
   наследниках.

   Порядок подключения: этот файл идёт первым среди -manager.js.
   ============================================================ */

class GameModule {
    constructor() {
        this.listeners = new Set();
    }

    /* ---------- Связь с картой ---------- */

    // Привязать менеджер к карте (в том числе к заново сгенерированной).
    // Наследник зовёт super.attach(map) и дальше сбрасывает своё состояние.
    attach(map) {
        this.map = map;
    }

    /* ---------- Подписка и уведомление ---------- */

    // Подписка на изменения: listener(...payload). Возвращает функцию отписки.
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // Оповестить подписчиков. Копия набора — чтобы отписка во время emit не сбила обход.
    emit(...payload) {
        for (const listener of [...this.listeners]) listener(...payload);
    }
}

/* ============================================================
   SECTION: VIEW_MODULE
   База для view-модулей (HUD): FactionView, PlayerView, TurnView,
   SelectionView, ArmyView.

   Менеджеры (GameModule) объявляют события через emit; view-модули их слушают.
   Раньше все подписки жили в main.js — один список на всю страницу, и модуль
   нельзя было переиспользовать, не тронув main. Теперь модуль сам подписывается
   на шину в setup() через listen(...) и сам же отписывается через teardown().

   Порядок подключения: как и GameModule — до менеджеров и view-модулей.
   ============================================================ */

class ViewModule {
    constructor() {
        this.subscriptions = [];
    }

    // Подписка на событие шины с запоминанием функции отписки.
    listen(game, name, handler) {
        const off = game.on(name, handler);
        this.subscriptions.push(off);
        return off;
    }

    // Подписка на несколько событий одним обработчиком.
    listenMany(game, names, handler) {
        for (const name of names) this.listen(game, name, handler);
    }

    // Снять все подписки (выгрузка модуля). Новая карта подписки не рвёт: шина живёт, пока живёт игра.
    teardown() {
        for (const off of this.subscriptions) off();
        this.subscriptions = [];
    }
}

// События, после которых панели игрока (фракции, ресурсы, выделение) показывают устаревшие
// данные: любой ход и любое изменение владений/строений/армий. Панели дешёвые — перерисовываем
// их все на каждое из этих событий (раньше это делал refreshPanels в main.js).
const HUD_EVENTS = ['factions:change', 'construction:change', 'armies:change', 'turn:end'];
