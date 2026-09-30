import { fileOf, onBoard, rankOf, sq } from '../board';
import { buildCtx, fx, markedBy } from '../effects';
import { cloneForSim, legalMoves } from '../movegen';
import type { Color, Effect, GameState, Move, Piece, PieceType, Square } from '../types';

export const squaresWhere = (state: GameState, pred: (p: Piece, s: Square) => boolean): Square[] => {
  const out: Square[] = [];
  for (let s = 0; s < 64; s++) {
    const p = state.board[s];
    if (p && pred(p, s)) out.push(s);
  }
  return out;
};

export const ownPieces = (state: GameState, c: Color, types?: PieceType[]): Square[] =>
  squaresWhere(state, (p) => p.color === c && (!types || types.includes(p.type)));

export const enemyPieces = (state: GameState, c: Color, types?: PieceType[]): Square[] =>
  squaresWhere(state, (p) => p.color !== c && (!types || types.includes(p.type)));

export const nonKing = (types: PieceType[] = ['Q', 'R', 'B', 'N', 'P']) => types;

export const wallSquares = (state: GameState): Set<Square> => buildCtx(state).walls;

/** Empty squares a piece may be put on: no wall, and not a home square reserved by „El az útból!”. */
export const emptySquares = (state: GameState): Square[] => {
  const ctx = buildCtx(state);
  const out: Square[] = [];
  for (let s = 0; s < 64; s++) if (!state.board[s] && !ctx.walls.has(s) && !ctx.reserved.has(s)) out.push(s);
  return out;
};

export const isEmpty = (state: GameState, s: Square): boolean => {
  if (state.board[s]) return false;
  const ctx = buildCtx(state);
  return !ctx.walls.has(s) && !ctx.reserved.has(s);
};

/** Piece is completely immobilised by „Gyengítés” / „Gyalogfagyasztás” (or stepped aside this turn). */
export function isImmobile(state: GameState, p: Piece): boolean {
  const ctx = buildCtx(state);
  return fx(ctx, p.id, 'weakened') || fx(ctx, p.id, 'frozen') || fx(ctx, p.id, 'outOfWay');
}

/** Piece may be relocated by one of its owner's spells (non-capturing). */
export function canRelocate(state: GameState, p: Piece): boolean {
  const ctx = buildCtx(state);
  return !fx(ctx, p.id, 'weakened') && !fx(ctx, p.id, 'frozen') && !fx(ctx, p.id, 'rooted') && !fx(ctx, p.id, 'outOfWay');
}

/** „Láthatatlanság”: the piece on `s` belongs to the opponent of `by` and cannot be targeted by `by`'s spells. */
export function wardedAgainst(state: GameState, s: Square, by: Color): boolean {
  const p = state.board[s];
  return !!p && p.color !== by && state.effects.some((e) => e.kind === 'spellWard' && e.pieceId === p.id);
}

export function hasEffect(state: GameState, p: Piece, kind: Effect['kind']): boolean {
  return state.effects.some((e) => e.pieceId === p.id && e.kind === kind);
}

/** Can `by` destroy / capture this piece with a spell (ignores fortify – that absorbs)? */
export function spellTargetable(state: GameState, p: Piece, by: Color): boolean {
  if (p.type === 'K') return false;
  const ctx = buildCtx(state);
  return !fx(ctx, p.id, 'immune') || markedBy(ctx, p.id, by);
}

/** Legal normal moves from `s` if the extra effect were active (preview for buff spells). */
export function movesWithEffect(state: GameState, s: Square, eff: Omit<Effect, 'id'>): Move[] {
  const copy = cloneForSim(state);
  copy.effects = [...copy.effects, { ...eff, id: 'preview' }];
  return legalMoves(copy).filter((m) => m.from === s);
}

export const mirrorSquare = (s: Square): Square => sq(7 - fileOf(s), rankOf(s));

export function rays(s: Square, dirs: readonly (readonly [number, number])[], max = 7): Square[] {
  const out: Square[] = [];
  for (const [df, dr] of dirs) {
    for (let d = 1; d <= max; d++) {
      const f = fileOf(s) + df * d;
      const r = rankOf(s) + dr * d;
      if (!onBoard(f, r)) break;
      out.push(sq(f, r));
    }
  }
  return out;
}

export const pieceCount = (state: GameState, c: Color): number => squaresWhere(state, (p) => p.color === c).length;
