import type { Color, GameState, SpellId, Square } from '../types';

export type SpellCategory =
  | 'Mozgás'
  | 'Védelem'
  | 'Irányítás'
  | 'Mana'
  | 'Terep'
  | 'Idő'
  | 'Pusztítás'
  | 'Taktika';

export type TargetType =
  | 'none'
  | 'ownPiece'
  | 'enemyPiece'
  | 'anyPiece'
  | 'emptySquare'
  | 'anySquare'
  | 'pieceThenSquare'
  | 'twoOwnPieces'
  | 'twoSquares'
  | 'multiSquare'
  | 'zone';

export interface TargetStep {
  /** Instruction shown while the player picks this target. */
  prompt: string;
}

export interface SpellContext {
  state: GameState;
  caster: Color;
  opp: Color;
  /** This cast is the card's awakened form (see `Spell.cycles`). */
  awakened?: boolean;
}

/**
 * A spell definition. Adding a new spell = adding one object to the registry:
 * the casting framework handles mana, silence, the cycle, target validation,
 * king-safety simulation, logging and animation events.
 */
export interface Spell {
  id: SpellId;
  /** Position in the original design list (1–50); additions continue from 51. */
  number: number;
  name: string;
  /** What the spell actually does in this implementation. */
  description: string;
  manaCost: number;
  category: SpellCategory;
  icon: string;
  targetType: TargetType;
  steps: TargetStep[];
  /** Extra preconditions (mana, turn, silence, cycle are checked by the framework). */
  canCast?(ctx: SpellContext): boolean;
  /** Candidate squares for step `picked.length` (the framework filters out illegal outcomes). */
  getTargets?(ctx: SpellContext, picked: Square[]): Square[];
  /** Mutates the (already cloned) state. */
  execute(ctx: SpellContext, targets: Square[]): void;
  /** Caster's king must not be in check afterwards, even if it was before. */
  requireKingSafe?: boolean;
  /** Only useful while the normal move (or bonus move) is still available. */
  needsNormalMove?: boolean;
  /** Only before this turn's normal move. */
  beforeMoveOnly?: boolean;
  /** Outcome uses the seeded RNG. */
  random?: boolean;
  /** Documentation of deviations from the original design (see SPELLS.md). */
  change?: { original: string; reason: string; originalCost?: number };
  /** Short label for the badge / effect list. */
  badge?: string;
  /**
   * Targets are independent of each other (only distinctness matters), e.g. „Brigád” with 5 squares.
   * The framework then validates one representative completion instead of every combination.
   */
  fastTargets?: boolean;
  /** Target-dependent mana cost (e.g. „Klón”); `manaCost` is then the minimum, shown as „N+”. */
  costFor?(ctx: SpellContext, targets: Square[]): number;
  /** Human-readable cost range for variable-cost spells, e.g. '2–6'. */
  costLabel?: string;
  /** May target pieces protected by „Láthatatlanság” (e.g. „Pajzsromboló”). */
  ignoresWard?: boolean;
  /**
   * „Körforgás” (like a Clash Royale evolution): the card has to be played this many times in its
   * plain form – each time it goes to the back of the deck – before it comes back awakened. The
   * awakened cast spends the charge, and the card starts charging again.
   */
  cycles?: number;
  /** The awakened form's name and rules text (cards with `cycles`). */
  awakened?: { name: string; description: string };
  /** Spell that was not part of the original 50-spell design. */
  added?: {
    reason: string;
    /** The proposal as the player wrote it, when the implementation deviates from it. */
    proposal?: string;
    /** Proposed mana cost, if it was changed for balance. */
    proposalCost?: number;
  };
}
