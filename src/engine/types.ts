// ─────────────────────────────────────────────────────────────────────────────
// Mana Chess – core types
// Every type here is plain, JSON-serialisable data so that a GameState can be
// sent over the network (online multiplayer) or stored without conversion.
// ─────────────────────────────────────────────────────────────────────────────

export type Color = 'w' | 'b';
/** 'S' = „Rabszolga” (summoned by Brigád): steps 1 forward, never captures or attacks. */
export type PieceType = 'K' | 'Q' | 'R' | 'B' | 'N' | 'P' | 'S';
export type PromotionPiece = 'Q' | 'R' | 'B' | 'N';

/** Square index 0..63, index = rank * 8 + file (a1 = 0, h1 = 7, a8 = 56, h8 = 63). */
export type Square = number;

export interface Piece {
  id: string;
  type: PieceType;
  color: Color;
  hasMoved: boolean;
  /** Square the piece stood on before its most recent relocation (used by „Visszalépés”). */
  prevSquare: Square | null;
  /** Created by „Klón”: shown translucent, dissolves right after it captures something. */
  clone?: boolean;
  /** Set on the captured-list copy of a clone that dissolved by itself (not captured by the opponent). */
  dissolved?: boolean;
  /** Set on the captured-list copy of a piece that broke under „Üvegátok” (the curse's owner is its killer). */
  shattered?: boolean;
}

export type Board = (Piece | null)[];

export type SpellId =
  | 'pawnRush' | 'knightLeap' | 'bishopBlessing' | 'rookCharge' | 'queenGrace' | 'kingStride'
  | 'pawnShield' | 'knightShield' | 'fortify' | 'sacrifice' | 'forcedMarch' | 'teleport'
  | 'swap' | 'emergencySwap' | 'stepBack' | 'doubleMove' | 'instantPromotion' | 'royalGuard'
  | 'checkBreaker' | 'recastle' | 'deathMark' | 'weaken' | 'root' | 'blindSpot'
  | 'silence' | 'manaDrain' | 'disarm' | 'pawnFreeze' | 'wall' | 'barricade'
  | 'gravity' | 'chaos' | 'mirror' | 'timeStop' | 'rewind' | 'earthquake'
  | 'dimensionShift' | 'bloodPrice' | 'overcharge' | 'arcaneSurge' | 'gambit'
  | 'lastChance' | 'execution' | 'meteor' | 'necromancy' | 'realityBreak' | 'brigade' | 'clone' | 'frenchCheese' | 'bishopSniper' | 'manaMage'
  | 'mine' | 'outOfWay' | 'quickCastle' | 'pawnVault' | 'provoke' | 'invisibility' | 'magnet' | 'repulse'
  | 'manaDeposit' | 'scout' | 'manaThirst' | 'retrain' | 'storm' | 'shieldBreaker' | 'gravityWell'
  | 'manaArmageddon' | 'dragonFire' | 'doomsday' | 'glassCurse' | 'doom';

export type EffectKind =
  | 'pawnRush'        // piece: may double-step this turn
  | 'bishopBlessing'  // piece: may jump over one own piece (once)
  | 'queenGrace'      // piece: queen may also move like a knight
  | 'kingStride'      // color: king may move 2 squares in a line this turn
  | 'immune'          // piece: cannot be captured
  | 'fortified'       // piece: first capture attempt fails, piece stays
  | 'doubleMove'      // color: bonus move after the normal move
  | 'royalGuard'      // color (protected): opponent may not give check
  | 'deathMark'       // piece: owner's next capture ignores protections
  | 'weakened'        // piece: cannot move at all
  | 'rooted'          // piece: may only capture
  | 'blinded'         // piece: may not capture
  | 'disarmed'        // piece: may not capture and does not attack (no check)
  | 'glassCursed'     // enemy piece: shatters right after it captures something
  | 'frozen'          // pawn: cannot move
  | 'silenced'        // color: cannot cast spells
  | 'wall'            // squares: impassable, cannot be entered
  | 'gravity'         // global: knights cannot jump over pieces
  | 'timeStop'        // color: no normal move, max 1 spell
  | 'discount'        // color: next spell costs 2 less (min 1)
  | 'manaCap'         // color: maximum mana is lowered
  | 'dimensionZone'   // squares: non-king pieces inside move like knights
  | 'realityBreak'    // color: movement rules loosened this turn
  | 'frenchCheese'    // pawn: may take any piece beside it en passant this turn
  | 'sniper'          // bishop: its captures this turn are shots (it does not move)
  | 'manaMage'        // piece (≤3 pts): +1 mana per own turn and per capture; its spell killer loses 1
  | 'mine'            // squares: explodes at the end of the opponent's next turn (a king next to it may defuse it)
  | 'outOfWay'        // piece: stepped aside this turn, returns at turn end; its home square is reserved
  | 'pawnVault'       // pawn: may jump over the piece right in front of it this turn
  | 'scout'           // pawn: may also step sideways this turn
  | 'provoked'        // enemy pawn: its owner's next normal move must be made with it (if possible)
  | 'spellWard'       // piece: the opponent's spells cannot target it
  | 'manaDeposit'     // color: +value mana at the start of the owner's next turn
  | 'manaThirst'      // color: the next capture this turn pays its value in mana
  | 'manaFamine';     // global: nobody gets the base mana income

export interface Effect {
  id: string;
  kind: EffectKind;
  /** The player who created the effect. */
  owner: Color;
  source: SpellId;
  pieceId?: string;
  /** Colour the effect applies to (for colour-scoped effects). */
  color?: Color;
  squares?: Square[];
  /** Effect is removed at the end of this turn index (inclusive). null = until consumed. */
  expiresAfterTurn: number | null;
  value?: number;
  /** „El az útból!”: the piece's state to restore when it returns home. */
  restore?: { hasMoved: boolean; prevSquare: Square | null };
}

export interface PlayerState {
  mana: number;
  /** Spell cycle queue. The first HAND_SIZE entries are the hand. */
  deck: SpellId[];
  deckName: string;
  spellsCast: number;
  captures: number;
  /** Increments every time the cycle rotates (used by the UI for animations). */
  cycleCount: number;
  /** „Körforgás”: plain casts of each card since its last awakened cast (see `Spell.cycles`). */
  charges: Partial<Record<SpellId, number>>;
}

export interface TurnState {
  normalMoveDone: boolean;
  firstMovePieceId: string | null;
  bonusMoveAvailable: boolean;
  spellsCast: number;
  /** A capture, pawn move or piece destruction happened this turn (50-move rule). */
  irreversible: boolean;
}

export interface EnPassant {
  /** Square a capturing pawn lands on. */
  target: Square;
  /** Square of the pawn that can be captured. */
  pawnSquare: Square;
  pawnId: string;
  /** Turn index in which the capture is allowed. */
  turn: number;
}

export interface Snapshot {
  board: Board;
  ep: EnPassant | null;
  halfmoveClock: number;
  moveListLength: number;
}

export type GameStatus =
  | { kind: 'playing' }
  | { kind: 'checkmate'; winner: Color }
  | { kind: 'stalemate' }
  | { kind: 'draw'; reason: string }
  | { kind: 'resigned'; winner: Color };

export interface PendingPromotion {
  square: Square;
  pieceId: string;
  color: Color;
  /** 'move' → after promotion the normal-move continuation runs (may end the turn). */
  context: 'move' | 'spell';
}

export interface Move {
  from: Square;
  to: Square;
  capture?: boolean;
  /** Square of the captured piece if different from `to` (en passant). */
  captureSquare?: Square;
  enPassant?: boolean;
  castle?: 'K' | 'Q';
  doubleStep?: boolean;
  promotion?: boolean;
  /** Bishop blessing jump used. */
  usedJump?: boolean;
  /** King stride (2-square king move). */
  stride?: boolean;
  /** „Futólövész”: capture from range – the capturing piece stays on its square. */
  ranged?: boolean;
  /** „Akna”: the king defuses the adjacent mine on `to` and stays where it is. */
  defuse?: boolean;
}

export interface MoveRecord {
  turnIndex: number;
  color: Color;
  san: string;
  kind: 'move' | 'bonus' | 'spell';
  rewound?: boolean;
}

export interface LogEntry {
  turnIndex: number;
  color: Color | null;
  kind: 'move' | 'spell' | 'mana' | 'system' | 'capture';
  text: string;
  spellId?: SpellId;
}

export type GameEvent =
  | { type: 'move'; pieceId: string; from: Square; to: Square }
  | { type: 'capture'; square: Square; piece: Piece; by: Color }
  | { type: 'destroy'; square: Square; piece: Piece }
  /** „Üvegátok”: the cursed piece broke right after its capture (on `square`). */
  | { type: 'shatter'; square: Square; piece: Piece }
  /** „Végzet”: the piece was erased from existence (not a capture, it never comes back). */
  | { type: 'erase'; square: Square; piece: Piece }
  | { type: 'bounce'; square: Square; attackerSquare: Square }
  | { type: 'shieldBlock'; square: Square }
  /** `awakened`: the card was played in its awakened form (see `Spell.cycles`). */
  | { type: 'spell'; spellId: SpellId; color: Color; squares: Square[]; awakened?: boolean }
  | { type: 'mana'; color: Color; delta: number; wasted: number; reason: string }
  | { type: 'cycle'; color: Color; used: SpellId; drawn: SpellId | null }
  | { type: 'promotion'; square: Square; piece: PieceType }
  | { type: 'check'; color: Color }
  | { type: 'turn'; color: Color }
  | { type: 'shot'; from: Square; to: Square; color: Color }
  | { type: 'explode'; square: Square }
  | { type: 'defuse'; square: Square }
  | { type: 'gameOver'; status: GameStatus };

export interface GameState {
  board: Board;
  turn: Color;
  /** 0 = White's first turn, 1 = Black's first turn, ... */
  turnIndex: number;
  players: Record<Color, PlayerState>;
  effects: Effect[];
  ep: EnPassant | null;
  halfmoveClock: number;
  /** Pieces of the given colour that were removed from the board. */
  captured: Record<Color, Piece[]>;
  /**
   * Pieces erased by „Végzet” (copies): not captured, nothing may ever bring them back, and an
   * erased officer's type is lost to its owner for good (no promotion, „Klón” or „Átképzés” into it).
   */
  erased: Piece[];
  snapshots: Snapshot[];
  log: LogEntry[];
  moveList: MoveRecord[];
  turnState: TurnState;
  pendingPromotion: PendingPromotion | null;
  status: GameStatus;
  /** Side to move is currently in check (or will be when this turn's effects expire). */
  inCheck: boolean;
  /** Side to move has no normal move and can only continue by casting a spell. */
  mustCastSpell: boolean;
  rng: number;
  nextId: number;
  events: GameEvent[];
  eventSeq: number;
  options: GameOptions;
}

export interface GameOptions {
  /**
   * true (default): the normal chess move ends the turn automatically.
   * false: after the normal move the player may still cast spells and ends the
   * turn with END_TURN („spell a lépés után is” variant).
   */
  autoEndTurn: boolean;
}

// ── Actions (the only way to change a GameState; serialisable for online play) ──
export type Action =
  | { type: 'MOVE'; from: Square; to: Square; promotion?: PromotionPiece }
  | { type: 'CAST'; spellId: SpellId; targets: Square[] }
  | { type: 'PROMOTE'; piece: PromotionPiece }
  | { type: 'END_TURN' }
  | { type: 'RESIGN'; color: Color }
  | { type: 'AGREE_DRAW' };

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };
