// Board operations used by spells (relocations, swaps, spell kills, sacrifices).
import { rankOf, promotionRank, squareName } from './board';
import { MANA, PIECE_NAME_HU, PIECE_VALUE } from './constants';
import { removeEffect, removePieceEffects } from './effects';
import { promotionChoices } from './erasure';
import { addLog, emit } from './log';
import { gainMana, loseMana } from './mana';
import { applyMoveRaw, type RawMoveResult } from './movegen';
import type { Color, GameState, Piece, Square } from './types';

export type DestroyResult = 'destroyed' | 'absorbed' | 'immune' | 'empty';

/** The piece carries a „Mana mágus” buff. */
export const isManaMage = (state: GameState, pieceId: string): boolean =>
  state.effects.some((e) => e.kind === 'manaMage' && e.pieceId === pieceId);

/** „Mana mágus”: a capture made by the mage is worth +1 extra mana. */
export function manaMageCaptureBonus(state: GameState, color: Color): void {
  const got = gainMana(state, color, 1, 'Mana mágus');
  addLog(state, color, 'mana', `Mana mágus ütött: ${got ? '+1 extra mana' : 'a mana tele, az extra bónusz elveszett'}.`);
}

/** Extra mana for a capture: „Mana mágus” (+1) and „Mana-szomj” (+ the victim's value, once). */
/** „Rabszolga”: taking a servant (Brigád) is worth a point but no mana. */
export const captureEarnsMana = (victim: Piece): boolean => victim.type !== 'S';

export function captureBonuses(state: GameState, color: Color, victim: Piece, byMage: boolean): void {
  if (byMage) manaMageCaptureBonus(state, color);
  const thirst = state.effects.find((e) => e.kind === 'manaThirst' && e.color === color);
  if (thirst) {
    removeEffect(state, thirst.id);
    const value = PIECE_VALUE[victim.type];
    const got = gainMana(state, color, value, 'Mana-szomj');
    addLog(state, color, 'mana', `Mana-szomj: a leütött ${PIECE_NAME_HU[victim.type]} ${value} manát ér → +${got} mana${got < value ? ' (a többi elveszett)' : ''}.`);
  }
}

/**
 * „Üvegátok”: announce a piece that broke after its capture (the board and the captured
 * list were already updated by `applyMoveRaw`). If it was a „Mana mágus”, the curse's owner
 * killed it with a spell and loses 1 mana, like any other spell kill of a mage.
 */
export function reportShatter(state: GameState, res: RawMoveResult, at: Square): void {
  if (!res.shattered) return;
  const p = res.piece;
  emit(state, { type: 'shatter', square: at, piece: { ...p } });
  addLog(state, p.color, 'capture', `Üvegátok: a(z) ${PIECE_NAME_HU[p.type]} ütés után darabokra tört (${squareName(at)}).`);
  if (res.shattered.mage) {
    const killer = res.shattered.owner;
    const lost = loseMana(state, killer, 1, 'Mana mágus megölése');
    addLog(state, killer, 'mana', `Az üvegátok ölte meg a mana mágust${lost ? ': −1 mana' : ' (nem volt több mana)'}.`);
  }
}

/** Takes a piece off the board (it goes to the captured list). */
export function removeFromBoard(state: GameState, s: Square): Piece | null {
  const p = state.board[s];
  if (!p) return null;
  state.board[s] = null;
  state.captured[p.color].push({ ...p });
  removePieceEffects(state, p.id);
  state.turnState.irreversible = true;
  emit(state, { type: 'destroy', square: s, piece: { ...p } });
  return p;
}

/**
 * A spell tries to destroy the piece on `s` (counts as a capture attempt):
 * „Gyalogpajzs/Huszárpajzs” make it immune, „Megerősítés/Utolsó esély” absorb it,
 * „Halálbélyeg” of the attacker ignores both.
 */
export function destroyByAttack(state: GameState, s: Square, by: Color): DestroyResult {
  const t = state.board[s];
  if (!t) return 'empty';
  if (t.type === 'K') return 'immune';
  const marked = state.effects.some((e) => e.kind === 'deathMark' && e.pieceId === t.id && e.owner === by);
  if (!marked && state.effects.some((e) => e.kind === 'immune' && e.pieceId === t.id)) {
    emit(state, { type: 'shieldBlock', square: s });
    return 'immune';
  }
  if (!marked) {
    const shield = state.effects
      .filter((e) => e.kind === 'fortified' && e.pieceId === t.id)
      .sort((a, b) => (a.expiresAfterTurn ?? 1e9) - (b.expiresAfterTurn ?? 1e9))[0];
    if (shield) {
      removeEffect(state, shield.id);
      emit(state, { type: 'shieldBlock', square: s });
      addLog(state, by, 'spell', `A(z) ${PIECE_NAME_HU[t.type]} (${squareName(s)}) megerősítése elnyelte a támadást.`);
      return 'absorbed';
    }
  }
  removeFromBoard(state, s);
  return 'destroyed';
}

/** Moves a piece to an empty square (teleports, swaps, step back…). */
export function relocate(state: GameState, from: Square, to: Square): Piece {
  const p = state.board[from]!;
  state.board[to] = p;
  state.board[from] = null;
  p.prevSquare = from;
  p.hasMoved = true;
  emit(state, { type: 'move', pieceId: p.id, from, to });
  if (p.type === 'P') state.turnState.irreversible = true;
  checkSpellPromotion(state, to);
  return p;
}

export function swapSquares(state: GameState, a: Square, b: Square): void {
  const pa = state.board[a]!;
  const pb = state.board[b]!;
  state.board[a] = pb;
  state.board[b] = pa;
  pa.prevSquare = a;
  pb.prevSquare = b;
  pa.hasMoved = true;
  pb.hasMoved = true;
  emit(state, { type: 'move', pieceId: pa.id, from: a, to: b });
  emit(state, { type: 'move', pieceId: pb.id, from: b, to: a });
}

/** If a pawn stands on its promotion rank after a spell, ask for a promotion piece. */
export function checkSpellPromotion(state: GameState, s: Square): void {
  const p = state.board[s];
  if (p && p.type === 'P' && rankOf(s) === promotionRank(p.color)) {
    // „Végzet” may have taken every piece it could become: then it simply stays a pawn
    if (!promotionChoices(state, p.color).length) {
      addLog(state, p.color, 'system', `A gyalog (${squareName(s)}) nem tud átváltozni: a Végzet minden lehetséges bábut kitörölt.`);
      return;
    }
    state.pendingPromotion = { square: s, pieceId: p.id, color: p.color, context: 'spell' };
  }
}

/**
 * A spell-driven chess move (e.g. „Huszárugrás”, „Bástyatöltés”) that may capture.
 * Uses the normal capture rules and grants capture mana, but is NOT the normal move.
 */
export function spellMove(state: GameState, from: Square, to: Square): RawMoveResult {
  const mover = state.board[from]!;
  const target = state.board[to];
  const capture = !!target && target.color !== mover.color;
  const mage = isManaMage(state, mover.id);
  const res = applyMoveRaw(state, { from, to, capture });
  if (res.bounced) {
    emit(state, { type: 'bounce', square: to, attackerSquare: from });
    addLog(state, mover.color, 'capture', `Megerősítés! A(z) ${squareName(to)} bábu túlélte a támadást.`);
    return res;
  }
  emit(state, { type: 'move', pieceId: mover.id, from, to });
  if (res.captured) {
    emit(state, { type: 'capture', square: to, piece: { ...res.captured }, by: mover.color });
    state.players[mover.color].captures++;
    state.turnState.irreversible = true;
    if (captureEarnsMana(res.captured)) gainMana(state, mover.color, MANA.PER_CAPTURE, 'capture');
    captureBonuses(state, mover.color, res.captured, mage);
  }
  if (res.cloneVanished) {
    emit(state, { type: 'destroy', square: to, piece: { ...mover } });
    addLog(state, mover.color, 'capture', `A klón (${PIECE_NAME_HU[mover.type]}) ütés után szertefoszlott.`);
    return res;
  }
  if (res.shattered) {
    reportShatter(state, res, to);
    return res;
  }
  if (mover.type === 'P') state.turnState.irreversible = true;
  checkSpellPromotion(state, to);
  return res;
}
