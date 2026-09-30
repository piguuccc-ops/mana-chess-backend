import type { PieceType } from './types';

/** Mana rules – tweak here to rebalance the whole game. */
export const MANA = {
  MAX: 6,
  START: 3,
  PER_TURN: 1,
  PER_CAPTURE: 1,
  /**
   * Both players start the game with 3 mana; the +1 turn income is granted from
   * each player's SECOND turn on, so the first turn is played with exactly 3.
   */
  GRANT_ON_FIRST_TURN: false,
} as const;

export const HAND_SIZE = 3;
export const DECK_SIZE = 6;

/** Piece values used by spells (Kivégzés, Meteor) and the UI material count. */
export const PIECE_VALUE: Record<PieceType, number> = {
  P: 1,
  N: 3,
  B: 3,
  R: 5,
  Q: 9,
  K: 100,
  S: 1,
};

/** Hungarian piece letters for notation (K, V, B, F, H; pawns have none). */
export const PIECE_LETTER_HU: Record<PieceType, string> = {
  K: 'K',
  Q: 'V',
  R: 'B',
  B: 'F',
  N: 'H',
  P: '',
  S: 'R',
};

export const PIECE_NAME_HU: Record<PieceType, string> = {
  K: 'király',
  Q: 'vezér',
  R: 'bástya',
  B: 'futó',
  N: 'huszár',
  P: 'gyalog',
  S: 'rabszolga',
};

export const COLOR_NAME_HU = { w: 'Világos', b: 'Sötét' } as const;

/** 100 plies (50 full moves) without capture / pawn move → draw. */
export const FIFTY_MOVE_PLIES = 100;
