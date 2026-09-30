// „Végzet” erases a piece from existence. If it was an officer (queen, rook, bishop or knight),
// its owner has lost that kind of piece for good: no pawn may promote into it any more, and
// neither „Klón” nor „Átképzés” may make a new one.
import type { Color, GameState, PieceType, PromotionPiece } from './types';

/** The pieces a pawn may promote into, strongest first. */
export const PROMOTION_PIECES: readonly PromotionPiece[] = ['Q', 'R', 'B', 'N'];

/** Has `color` lost this kind of piece to „Végzet”? (Only officers count: pawns, servants and kings never do.) */
export const isLostType = (state: GameState, color: Color, type: PieceType): boolean =>
  (PROMOTION_PIECES as readonly PieceType[]).includes(type) && state.erased.some((p) => p.color === color && p.type === type);

/** The officer types `color` has lost to „Végzet”, strongest first. */
export const lostTypes = (state: GameState, color: Color): PromotionPiece[] =>
  PROMOTION_PIECES.filter((t) => isLostType(state, color, t));

/** What a pawn of `color` may still promote into, strongest first (empty: nothing is left). */
export const promotionChoices = (state: GameState, color: Color): PromotionPiece[] =>
  PROMOTION_PIECES.filter((t) => !isLostType(state, color, t));

/** Hungarian „into a …” forms for the promotion messages. */
export const INTO_HU: Record<PromotionPiece, string> = { Q: 'vezérré', R: 'bástyává', B: 'futóvá', N: 'huszárrá' };
