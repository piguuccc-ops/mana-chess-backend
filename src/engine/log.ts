import type { Color, GameEvent, GameState, LogEntry, SpellId } from './types';

export function addLog(
  state: GameState, color: Color | null, kind: LogEntry['kind'], text: string, spellId?: SpellId,
): void {
  state.log.push({ turnIndex: state.turnIndex, color, kind, text, ...(spellId ? { spellId } : {}) });
}

export function emit(state: GameState, ev: GameEvent): void {
  state.events.push(ev);
}
