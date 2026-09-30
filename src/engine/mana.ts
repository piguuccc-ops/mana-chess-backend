import { MANA } from './constants';
import { colorEffect } from './effects';
import { emit } from './log';
import type { Color, GameState } from './types';

/** Current maximum mana of a player (6, or lower while „Arcane Surge” is active). */
export function maxMana(state: GameState, color: Color): number {
  const cap = colorEffect(state, color, 'manaCap');
  return cap?.value !== undefined ? Math.min(MANA.MAX, cap.value) : MANA.MAX;
}

/** Adds mana (never above the maximum). Returns the amount actually gained. */
export function gainMana(state: GameState, color: Color, amount: number, reason: string): number {
  const pl = state.players[color];
  const max = maxMana(state, color);
  const before = pl.mana;
  pl.mana = Math.max(0, Math.min(max, pl.mana + amount));
  const gained = pl.mana - before;
  const wasted = Math.max(0, amount - gained);
  emit(state, { type: 'mana', color, delta: gained, wasted, reason });
  return gained;
}

/** Removes mana (never below 0). Returns the amount actually lost. */
export function loseMana(state: GameState, color: Color, amount: number, reason: string): number {
  const pl = state.players[color];
  const lost = Math.min(pl.mana, amount);
  pl.mana -= lost;
  emit(state, { type: 'mana', color, delta: -lost, wasted: 0, reason });
  return lost;
}

/** Clamp to the current maximum (used when a cap becomes active). */
export function clampMana(state: GameState, color: Color): void {
  const pl = state.players[color];
  pl.mana = Math.min(pl.mana, maxMana(state, color));
}
