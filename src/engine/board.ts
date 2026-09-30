import type { Board, Color, Piece, PieceType, Square } from './types';

export const fileOf = (sq: Square): number => sq & 7;
export const rankOf = (sq: Square): number => sq >> 3;
export const sq = (file: number, rank: number): Square => rank * 8 + file;
export const onBoard = (file: number, rank: number): boolean =>
  file >= 0 && file < 8 && rank >= 0 && rank < 8;
export const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

const FILES = 'abcdefgh';
export const squareName = (s: Square): string => FILES[fileOf(s)] + (rankOf(s) + 1);
export const parseSquare = (name: string): Square => {
  const f = FILES.indexOf(name[0]);
  const r = Number(name[1]) - 1;
  if (f < 0 || r < 0 || r > 7) throw new Error(`Invalid square: ${name}`);
  return sq(f, r);
};

/** Rank index where pawns of this colour start (0-based). */
export const pawnStartRank = (c: Color): number => (c === 'w' ? 1 : 6);
/** Rank index where pawns of this colour promote. */
export const promotionRank = (c: Color): number => (c === 'w' ? 7 : 0);
/** Own back rank (pawns may never stand here). */
export const backRank = (c: Color): number => (c === 'w' ? 0 : 7);
export const pawnDir = (c: Color): number => (c === 'w' ? 1 : -1);
/** Rank relative to the player (0 = own back rank, 7 = promotion rank). */
export const relRank = (c: Color, s: Square): number => (c === 'w' ? rankOf(s) : 7 - rankOf(s));

export const chebyshev = (a: Square, b: Square): number =>
  Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));

export const neighbours = (s: Square): Square[] => {
  const out: Square[] = [];
  const f = fileOf(s);
  const r = rankOf(s);
  for (let df = -1; df <= 1; df++)
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      if (onBoard(f + df, r + dr)) out.push(sq(f + df, r + dr));
    }
  return out;
};

export const orthNeighbours = (s: Square): Square[] => {
  const out: Square[] = [];
  const f = fileOf(s);
  const r = rankOf(s);
  for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
    if (onBoard(f + df, r + dr)) out.push(sq(f + df, r + dr));
  return out;
};

export const findKing = (board: Board, c: Color): Square => {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.type === 'K' && p.color === c) return i;
  }
  return -1;
};

export const findPiece = (board: Board, id: string): Square => {
  for (let i = 0; i < 64; i++) if (board[i]?.id === id) return i;
  return -1;
};

export const cloneBoard = (board: Board): Board => board.map((p) => (p ? { ...p } : null));

/** Is a pawn of colour c allowed to stand on square s? (never on either back rank) */
export const pawnSquareOk = (_c: Color, s: Square): boolean => rankOf(s) !== 0 && rankOf(s) !== 7;

// ── FEN ────────────────────────────────────────────────────────────────────
export interface ParsedFen {
  board: Board;
  turn: Color;
  epTarget: Square | null;
  halfmove: number;
  fullmove: number;
  nextId: number;
}

const FEN_TYPES: Record<string, PieceType> = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: 'P' };

export function parseFen(fen: string): ParsedFen {
  const [placement, turnStr = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const board: Board = new Array(64).fill(null);
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error('Invalid FEN');
  let id = 1;
  rows.forEach((row, i) => {
    const rank = 7 - i;
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const type = FEN_TYPES[ch.toLowerCase()];
      if (!type) throw new Error(`Invalid FEN piece ${ch}`);
      const color: Color = ch === ch.toUpperCase() ? 'w' : 'b';
      const s = sq(file, rank);
      board[s] = { id: `p${id++}`, type, color, hasMoved: true, prevSquare: null };
      file++;
    }
  });
  // Pawns on their start rank have not moved; kings/rooks get rights from the castling field.
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (!p) continue;
    if (p.type === 'P') p.hasMoved = rankOf(s) !== pawnStartRank(p.color);
    else if (p.type !== 'K' && p.type !== 'R') p.hasMoved = rankOf(s) !== backRank(p.color);
  }
  const grant = (c: Color, side: 'K' | 'Q') => {
    const r = backRank(c);
    const king = board[sq(4, r)];
    const rook = board[sq(side === 'K' ? 7 : 0, r)];
    if (king && king.type === 'K' && king.color === c) king.hasMoved = false;
    if (rook && rook.type === 'R' && rook.color === c) rook.hasMoved = false;
  };
  if (castling !== '-') {
    for (const ch of castling) {
      if (ch === 'K') grant('w', 'K');
      if (ch === 'Q') grant('w', 'Q');
      if (ch === 'k') grant('b', 'K');
      if (ch === 'q') grant('b', 'Q');
    }
  }
  return {
    board,
    turn: turnStr === 'b' ? 'b' : 'w',
    epTarget: ep !== '-' ? parseSquare(ep) : null,
    halfmove: Number(half) || 0,
    fullmove: Number(full) || 1,
    nextId: id,
  };
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function boardToFenPlacement(board: Board): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[sq(f, r)];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) {
        row += empty;
        empty = 0;
      }
      const ch = p.type.toLowerCase();
      row += p.color === 'w' ? ch.toUpperCase() : ch;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

export const pieceAt = (board: Board, s: Square): Piece | null => board[s] ?? null;
