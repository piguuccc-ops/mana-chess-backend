// Public API of the Mana Chess engine (UI, AI and networking only import from here).
export * from './types';
export * from './constants';
export {
  fileOf, rankOf, sq, squareName, parseSquare, opposite, findKing, parseFen, START_FEN, boardToFenPlacement, relRank,
} from './board';
export { createGame, applyAction, mustApply, evaluateStatus, type NewGameOptions } from './game';
export {
  legalMoves, legalMovesFrom, inCheck, isSafe, cloneState, hasLegalMove, provokedSquares, projectTurnEnd,
} from './movegen';
export { maxMana } from './mana';
export { PROMOTION_PIECES, isLostType, lostTypes, promotionChoices } from './erasure';
export { colorHas } from './effects';
export { hand, nextCard, canEndTurn, endTurnBlockReason, normalMoveAvailable } from './rules';
export {
  SPELLS, SPELL_LIST, REMOVED_SPELLS, BRIGADE_SIZE, METEOR_BUDGET, DRAGON_FIRE_BUDGET, MANA_DEPOSIT_RETURN, SKIPPED_PROPOSALS, getSpell,
  CATEGORY_ORDER,
} from './spells';
export type { Spell, SpellCategory, TargetType } from './spells';
export {
  castBlockReason, canCast, chargeOf, isAwakened, validTargets, effectiveCost, simulateCast, targetCombos,
} from './spells/cast';
export {
  COST_LIMITS, costLimitReason, deckShapeError, PRESET_DECKS, RANDOM_DECK_ID, randomDeck, validateDeck, type DeckDef,
} from './decks';
export {
  DRAFT_CHEAP_MIN, DRAFT_COLUMNS, DRAFT_POOL_SIZE, DRAFT_ROWS, applyPick, draftDone, draftPool, draftTurn, isValidDraft, newDraft, pickBlockReason,
  pickLimitReason, takenBy, type Draft,
} from './draft';
