import { HAND_SIZE } from './constants';
import { colorHas } from './effects';
import { isSafe } from './movegen';
import type { Color, GameState, SpellId } from './types';

export const hand = (state: GameState, color: Color): SpellId[] => state.players[color].deck.slice(0, HAND_SIZE);
export const nextCard = (state: GameState, color: Color): SpellId | null => state.players[color].deck[HAND_SIZE] ?? null;

/** Can the side to move still make its normal chess move this turn? */
export function normalMoveAvailable(state: GameState): boolean {
  const ts = state.turnState;
  return !ts.normalMoveDone || ts.bonusMoveAvailable;
}

/** Why the side to move may not end its turn right now (null = it may). */
export function endTurnBlockReason(state: GameState): string | null {
  if (state.status.kind !== 'playing') return 'A játszma véget ért.';
  if (state.pendingPromotion) return 'Előbb válaszd ki, mivé változzon a gyalog.';
  const c = state.turn;
  const ts = state.turnState;
  if (!isSafe(state, c)) return 'A királyod sakkban van (vagy a kör végén sakkba kerülne) – hárítsd el!';
  if (ts.normalMoveDone || ts.spellsCast > 0 || colorHas(state, c, 'timeStop')) return null;
  return 'Lépned kell, vagy használj legalább egy spellt a kör befejezése előtt.';
}

export const canEndTurn = (state: GameState): boolean => endTurnBlockReason(state) === null;
