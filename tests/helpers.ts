import {
  applyAction, createGame, legalMoves, mustApply, parseSquare, SPELL_LIST,
} from '../src/engine';
import type { Action, ActionResult, GameState, Piece, PromotionPiece, SpellId } from '../src/engine';

export const S = parseSquare;

/** A 6-card deck that starts with the given spells (hand = first three). */
export function deckWith(...ids: SpellId[]): SpellId[] {
  const deck = [...ids];
  for (const s of SPELL_LIST) {
    if (deck.length >= 6) break;
    if (!deck.includes(s.id) && !['chaos', 'gambit'].includes(s.id)) deck.push(s.id);
  }
  return deck;
}

export interface GameOpts {
  w?: SpellId[];
  b?: SpellId[];
  mana?: number | { w: number; b: number };
  seed?: number;
}

export function game(fen?: string, o: GameOpts = {}): GameState {
  const mana = typeof o.mana === 'number' ? { w: o.mana, b: o.mana } : o.mana;
  return createGame({
    fen,
    seed: o.seed ?? 12345,
    decks: { w: o.w ?? [], b: o.b ?? [] },
    mana,
  });
}

export function move(s: GameState, from: string, to: string, promotion?: PromotionPiece): GameState {
  return mustApply(s, { type: 'MOVE', from: S(from), to: S(to), ...(promotion ? { promotion } : {}) });
}

export function tryMove(s: GameState, from: string, to: string): ActionResult {
  return applyAction(s, { type: 'MOVE', from: S(from), to: S(to) });
}

export function cast(s: GameState, id: SpellId, ...targets: string[]): GameState {
  return mustApply(s, { type: 'CAST', spellId: id, targets: targets.map(S) });
}

export function tryCast(s: GameState, id: SpellId, ...targets: string[]): ActionResult {
  return applyAction(s, { type: 'CAST', spellId: id, targets: targets.map(S) });
}

export function act(s: GameState, a: Action): GameState {
  return mustApply(s, a);
}

export const endTurn = (s: GameState): GameState => mustApply(s, { type: 'END_TURN' });

export const at = (s: GameState, name: string): Piece | null => s.board[S(name)];

export const canMove = (s: GameState, from: string, to: string): boolean =>
  legalMoves(s).some((m) => m.from === S(from) && m.to === S(to));

export function perft(s: GameState, d: number): number {
  const moves = legalMoves(s);
  if (d === 1) return moves.reduce((n, m) => n + (m.promotion ? 4 : 1), 0);
  let n = 0;
  for (const m of moves) {
    const promos: (PromotionPiece | undefined)[] = m.promotion ? ['Q', 'R', 'B', 'N'] : [undefined];
    for (const pc of promos) {
      const r = applyAction(s, { type: 'MOVE', from: m.from, to: m.to, ...(pc ? { promotion: pc } : {}) });
      if (!r.ok) throw new Error(r.error);
      n += perft(r.state, d - 1);
    }
  }
  return n;
}
