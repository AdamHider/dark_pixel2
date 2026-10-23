/* ============================================================
   Turn — ход

   Карта не управляет ходами, экономикой и фракциями: этим занимаются отдельные модули (turn-manager.js, economy-manager.js,
   faction-manager.js). Они передают сюда готовое состояние (Turn / Economy / Factions .apply), карта его хранит, показывает
   и оповещает подписчиков — так рендерер перерисовывается сам. Данные копируются: менеджер остаётся единственным владельцем состояния.
   ============================================================ */
{
    MapGen.Turn = {
        // Ход: state = { turn, year, season, seasonIndex, turnInSeason, version } — текущее время; сезон показывает рендерер.
        apply(map, state) {
            map.turnState = { ...state, version: state.version === undefined ? map.turnState.version + 1 : state.version };
            map.turnChannel.emit(map.turnState);
        }
    };
}
