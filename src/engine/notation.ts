import { fileOf, rankOf, squareName } from './board';
import { PIECE_LETTER_HU } from './constants';
import type { GameState, Move, PieceType } from './types';

/** Hungarian short algebraic notation (K, V, B, F, H), e.g. „Hf3”, „exd5”, „O-O”. */
export function moveToSan(state: GameState, move: Move, legal: Move[]): string {
  const p = state.board[move.from];
  if (!p) return '?';
  if (move.castle) return move.castle === 'K' ? 'O-O' : 'O-O-O';
  if (move.defuse) return `K(💣${squareName(move.to)})`;
  const dest = squareName(move.to);
  const cap = move.capture ? 'x' : '';
  if (p.type === 'P') {
    const sideways = !move.capture && fileOf(move.from) !== fileOf(move.to); // „Cserkész”
    const base = move.capture ? `${'abcdefgh'[fileOf(move.from)]}x${dest}` : sideways ? `${squareName(move.from)}-${dest}` : dest;
    return base + (move.enPassant ? ' e.p.' : '');
  }
  const rivals = legal.filter(
    (m) => m.to === move.to && m.from !== move.from && state.board[m.from]?.type === p.type,
  );
  let dis = '';
  if (rivals.length) {
    const sameFile = rivals.some((m) => fileOf(m.from) === fileOf(move.from));
    const sameRank = rivals.some((m) => rankOf(m.from) === rankOf(move.from));
    if (!sameFile) dis = 'abcdefgh'[fileOf(move.from)];
    else if (!sameRank) dis = String(rankOf(move.from) + 1);
    else dis = squareName(move.from);
  }
  return `${PIECE_LETTER_HU[p.type]}${dis}${cap}${dest}`;
}

export const promotionSuffix = (t: PieceType): string => `=${PIECE_LETTER_HU[t]}`;
