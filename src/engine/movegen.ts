// ─────────────────────────────────────────────────────────────────────────────
// Effect-aware move generation, attack detection and king safety.
// ─────────────────────────────────────────────────────────────────────────────
import {
  backRank, chebyshev, fileOf, onBoard, opposite, pawnDir, pawnStartRank, pawnSquareOk, promotionRank, rankOf, sq,
  findKing,
} from './board';
import {
  buildCtx, colorHas, expireEffects, fx, geometryChangesAtTurnEnd, markedBy, removeEffect, removePieceEffects,
  type RulesCtx,
} from './effects';
import { promotionChoices } from './erasure';
import { applyTurnEndChanges } from './turnEnd';
import type { Board, Color, GameState, Move, Piece, Square } from './types';

type Mode = 'moves' | 'attacks';

export interface Target {
  to: Square;
  capture?: boolean;
  captureSquare?: Square;
  enPassant?: boolean;
  castle?: 'K' | 'Q';
  doubleStep?: boolean;
  usedJump?: boolean;
  stride?: boolean;
  ranged?: boolean;
}

type Dir = readonly [number, number];
export const ORTH: readonly Dir[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const DIAG: readonly Dir[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
export const ALL_DIRS: readonly Dir[] = [...ORTH, ...DIAG];
export const KNIGHT_JUMPS: readonly Dir[] = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

// ── State cloning ───────────────────────────────────────────────────────────

/** Full deep-enough copy used by the reducer (every mutable part is copied). */
export function cloneState(s: GameState): GameState {
  return {
    ...s,
    board: s.board.map((p) => (p ? { ...p } : null)),
    players: {
      w: { ...s.players.w, deck: [...s.players.w.deck], charges: { ...s.players.w.charges } },
      b: { ...s.players.b, deck: [...s.players.b.deck], charges: { ...s.players.b.charges } },
    },
    effects: s.effects.map((e) => ({ ...e })),
    ep: s.ep ? { ...s.ep } : null,
    captured: { w: [...s.captured.w], b: [...s.captured.b] },
    erased: [...s.erased],
    snapshots: [...s.snapshots],
    log: [...s.log],
    moveList: [...s.moveList],
    turnState: { ...s.turnState },
    options: { ...s.options },
    pendingPromotion: s.pendingPromotion ? { ...s.pendingPromotion } : null,
    status: { ...s.status },
    events: [],
  };
}

/** Cheaper copy for legality simulation (log/move list are shared and must not be touched). */
export function cloneForSim(s: GameState): GameState {
  return {
    ...s,
    board: s.board.map((p) => (p ? { ...p } : null)),
    players: {
      w: { ...s.players.w, deck: [...s.players.w.deck] },
      b: { ...s.players.b, deck: [...s.players.b.deck] },
    },
    effects: [...s.effects],
    ep: s.ep,
    captured: { w: [...s.captured.w], b: [...s.captured.b] },
    erased: [...s.erased],
    snapshots: [...s.snapshots],
    turnState: { ...s.turnState },
    events: [],
  };
}

// ── Capture rules ───────────────────────────────────────────────────────────

/** Can a piece of colour `by` capture whatever stands on square `s`? (kings: never) */
export function canCaptureOn(ctx: RulesCtx, board: Board, s: Square, by: Color): boolean {
  const t = board[s];
  if (!t || t.color === by || t.type === 'K') return false;
  if (fx(ctx, t.id, 'immune') && !markedBy(ctx, t.id, by)) return false;
  return true;
}

// ── Pattern generators ──────────────────────────────────────────────────────

function pushTarget(out: Target[], t: Target) {
  out.push(t);
}

function genSlide(
  state: GameState, ctx: RulesCtx, s: Square, c: Color, dirs: readonly Dir[], mode: Mode, out: Target[],
  /** ignoreBlockers: „Valóságtörés” – slide through the mover's own pieces. */
  opts: { max?: number; ignoreBlockers?: boolean; jumpOwnOnce?: boolean } = {},
) {
  const board = state.board;
  const max = opts.max ?? 7;
  const f0 = fileOf(s);
  const r0 = rankOf(s);
  for (const [df, dr] of dirs) {
    let jumped = false;
    for (let d = 1; d <= max; d++) {
      const f = f0 + df * d;
      const r = r0 + dr * d;
      if (!onBoard(f, r)) break;
      const t = sq(f, r);
      if (ctx.walls.has(t)) break;
      const q = board[t];
      if (!q) {
        pushTarget(out, { to: t, usedJump: jumped || undefined });
        continue;
      }
      if (mode === 'attacks') pushTarget(out, { to: t });
      else if (q.color !== c && canCaptureOn(ctx, board, t, c)) pushTarget(out, { to: t, capture: true, usedJump: jumped || undefined });
      if (opts.ignoreBlockers && q.color === c) continue; // „Valóságtörés”: through own pieces only
      if (opts.jumpOwnOnce && !jumped && q.color === c) {
        jumped = true;
        continue;
      }
      break;
    }
  }
}

function genKnight(state: GameState, ctx: RulesCtx, s: Square, c: Color, mode: Mode, out: Target[]) {
  const board = state.board;
  const f0 = fileOf(s);
  const r0 = rankOf(s);
  for (const [df, dr] of KNIGHT_JUMPS) {
    const f = f0 + df;
    const r = r0 + dr;
    if (!onBoard(f, r)) continue;
    const t = sq(f, r);
    if (ctx.gravity) {
      // „Gravitáció”: a knight cannot jump – the orthogonal square next to it in the
      // direction of the long leg must be empty (xiangqi-style hobbled horse).
      const b = Math.abs(df) === 2 ? sq(f0 + Math.sign(df), r0) : sq(f0, r0 + Math.sign(dr));
      if (board[b] || ctx.walls.has(b)) continue;
    }
    if (mode === 'attacks') {
      pushTarget(out, { to: t });
      continue;
    }
    if (ctx.walls.has(t)) continue;
    if (!board[t]) pushTarget(out, { to: t });
    else if (canCaptureOn(ctx, board, t, c)) pushTarget(out, { to: t, capture: true });
  }
}

function genSteps(state: GameState, ctx: RulesCtx, s: Square, c: Color, mode: Mode, out: Target[]) {
  const board = state.board;
  const f0 = fileOf(s);
  const r0 = rankOf(s);
  for (const [df, dr] of ALL_DIRS) {
    const f = f0 + df;
    const r = r0 + dr;
    if (!onBoard(f, r)) continue;
    const t = sq(f, r);
    if (mode === 'attacks') {
      pushTarget(out, { to: t });
      continue;
    }
    if (ctx.walls.has(t)) continue;
    if (!board[t]) pushTarget(out, { to: t });
    else if (canCaptureOn(ctx, board, t, c)) pushTarget(out, { to: t, capture: true });
  }
}

function genPawn(state: GameState, ctx: RulesCtx, s: Square, p: Piece, mode: Mode, out: Target[], loose: boolean) {
  const board = state.board;
  const c = p.color;
  const f0 = fileOf(s);
  const r0 = rankOf(s);
  const dir = pawnDir(c);
  const r1 = r0 + dir;
  if (r1 < 0 || r1 > 7) return;
  // Diagonal captures / attacks
  for (const df of [-1, 1]) {
    const f = f0 + df;
    if (f < 0 || f > 7) continue;
    const t = sq(f, r1);
    if (mode === 'attacks') {
      pushTarget(out, { to: t });
      continue;
    }
    if (ctx.walls.has(t)) continue;
    if (canCaptureOn(ctx, board, t, c)) pushTarget(out, { to: t, capture: true });
    else if (!board[t] && isEpValid(state, ctx, t, c)) {
      pushTarget(out, { to: t, capture: true, enPassant: true, captureSquare: state.ep!.pawnSquare });
    }
  }
  if (mode === 'attacks') return;
  // „Francia sajt”: en passant against ANY enemy piece standing right beside the pawn.
  if (fx(ctx, p.id, 'frenchCheese')) {
    for (const df of [-1, 1]) {
      const f = f0 + df;
      if (f < 0 || f > 7) continue;
      const side = sq(f, r0);
      const t = sq(f, r1);
      if (board[t] || ctx.walls.has(t)) continue;
      const victim = board[side];
      if (!victim || victim.color === c || victim.type === 'Q' || !canCaptureOn(ctx, board, side, c)) continue; // never the queen
      pushTarget(out, { to: t, capture: true, enPassant: true, captureSquare: side });
    }
  }
  // „Cserkész”: one step sideways onto an empty square (no capture).
  if (fx(ctx, p.id, 'scout')) {
    for (const df of [-1, 1]) {
      const f = f0 + df;
      if (f < 0 || f > 7) continue;
      const t = sq(f, r0);
      if (!board[t] && !ctx.walls.has(t)) pushTarget(out, { to: t });
    }
  }
  // Pushes
  const s1 = sq(f0, r1);
  if (!board[s1] && !ctx.walls.has(s1)) pushTarget(out, { to: s1 });
  // „Gyalogugrás”: jump over the piece directly in front onto the empty square behind it.
  if (board[s1] && !ctx.walls.has(s1) && fx(ctx, p.id, 'pawnVault')) {
    const rv = r0 + 2 * dir;
    if (rv >= 0 && rv <= 7) {
      const t = sq(f0, rv);
      if (!board[t] && !ctx.walls.has(t)) pushTarget(out, { to: t });
    }
  }
  const canDouble = r0 === pawnStartRank(c) || fx(ctx, p.id, 'pawnRush');
  const r2 = r0 + 2 * dir;
  if (canDouble && r2 >= 0 && r2 <= 7) {
    const s2 = sq(f0, r2);
    if (!ctx.walls.has(s1) && !ctx.walls.has(s2) && !board[s2] && (!board[s1] || (loose && board[s1]!.color === p.color))) {
      pushTarget(out, { to: s2, doubleStep: true });
    }
  }
}

function isEpValid(state: GameState, ctx: RulesCtx, target: Square, c: Color): boolean {
  const ep = state.ep;
  if (!ep || ep.turn !== state.turnIndex || ep.target !== target) return false;
  const victim = state.board[ep.pawnSquare];
  if (!victim || victim.id !== ep.pawnId || victim.color === c || victim.type !== 'P') return false;
  return canCaptureOn(ctx, state.board, ep.pawnSquare, c);
}

function genKing(state: GameState, ctx: RulesCtx, s: Square, p: Piece, mode: Mode, out: Target[]) {
  genSteps(state, ctx, s, p.color, mode, out);
  if (mode === 'attacks') return;
  const board = state.board;
  const c = p.color;
  // „Királylépés”: two squares in a straight line through an empty square.
  if (colorHas(state, c, 'kingStride')) {
    const f0 = fileOf(s);
    const r0 = rankOf(s);
    for (const [df, dr] of ALL_DIRS) {
      if (!onBoard(f0 + 2 * df, r0 + 2 * dr)) continue;
      const mid = sq(f0 + df, r0 + dr);
      const t = sq(f0 + 2 * df, r0 + 2 * dr);
      if (board[mid] || ctx.walls.has(mid) || ctx.walls.has(t)) continue;
      if (!board[t]) pushTarget(out, { to: t, stride: true });
      else if (canCaptureOn(ctx, board, t, c)) pushTarget(out, { to: t, capture: true, stride: true });
    }
  }
  // Castling
  const br = backRank(c);
  if (!p.hasMoved && s === sq(4, br)) {
    const kRook = board[sq(7, br)];
    if (kRook && kRook.type === 'R' && kRook.color === c && !kRook.hasMoved) {
      const path = [sq(5, br), sq(6, br)];
      if (path.every((x) => !board[x] && !ctx.walls.has(x) && !ctx.reserved.has(x))) pushTarget(out, { to: sq(6, br), castle: 'K' });
    }
    const qRook = board[sq(0, br)];
    if (qRook && qRook.type === 'R' && qRook.color === c && !qRook.hasMoved) {
      const path = [sq(1, br), sq(2, br), sq(3, br)];
      if (path.every((x) => !board[x] && !ctx.walls.has(x)) && !ctx.reserved.has(sq(2, br)) && !ctx.reserved.has(sq(3, br))) {
        pushTarget(out, { to: sq(2, br), castle: 'Q' });
      }
    }
  }
}

/**
 * All targets of the piece standing on `s`, taking every active effect into account.
 * In 'attacks' mode returns attacked squares (used for check detection).
 */
export function pieceTargets(state: GameState, ctx: RulesCtx, s: Square, mode: Mode): Target[] {
  const p = state.board[s];
  if (!p) return [];
  if (p.type === 'S' && mode === 'attacks') return []; // „Rabszolga”: never attacks, never gives check
  const out: Target[] = [];
  const c = p.color;
  const loose = p.type !== 'K' && ctx.realityBreak[c];
  if (p.type !== 'K' && ctx.zone.has(s)) {
    // „Dimenzióváltás”: every non-king piece in the zone moves like a knight.
    genKnight(state, ctx, s, c, mode, out);
  } else {
    switch (p.type) {
      case 'P':
        genPawn(state, ctx, s, p, mode, out, loose);
        break;
      case 'N':
        genKnight(state, ctx, s, c, mode, out);
        break;
      case 'B':
        genSlide(state, ctx, s, c, DIAG, mode, out, { ignoreBlockers: loose, jumpOwnOnce: fx(ctx, p.id, 'bishopBlessing') });
        break;
      case 'R':
        genSlide(state, ctx, s, c, ORTH, mode, out, { ignoreBlockers: loose });
        break;
      case 'Q':
        genSlide(state, ctx, s, c, ALL_DIRS, mode, out, { ignoreBlockers: loose });
        if (fx(ctx, p.id, 'queenGrace')) genKnight(state, ctx, s, c, mode, out);
        break;
      case 'K':
        genKing(state, ctx, s, p, mode, out);
        break;
      case 'S':
        genServant(state, ctx, s, p, out);
        break;
    }
  }
  let result = dedupe(out, p, mode);
  // „El az útból!”: nobody may land on the reserved home square this turn.
  if (mode === 'moves' && ctx.reserved.size) result = result.filter((t) => !ctx.reserved.has(t.to));
  if (p.type === 'S') return result.filter((t) => !t.capture);
  // „Futólövész”: every capture of this piece is a shot – it stays where it is.
  if (mode === 'moves' && fx(ctx, p.id, 'sniper')) return result.map((t) => (t.capture ? { ...t, ranged: true } : t));
  return result;
}

/** „Rabszolga”: one square straight forward onto an empty square – no double step, no capture. */
function genServant(state: GameState, ctx: RulesCtx, s: Square, p: Piece, out: Target[]) {
  const r1 = rankOf(s) + pawnDir(p.color);
  if (r1 < 0 || r1 > 7) return;
  const t = sq(fileOf(s), r1);
  if (!state.board[t] && !ctx.walls.has(t)) pushTarget(out, { to: t });
}

function dedupe(out: Target[], p: Piece, mode: Mode): Target[] {
  const seen = new Map<Square, Target>();
  for (const t of out) {
    if (p.type === 'P' && mode === 'moves' && rankOf(t.to) === backRank(p.color)) continue; // pawns never go backwards onto the back rank
    const prev = seen.get(t.to);
    if (!prev) seen.set(t.to, t);
    else if (t.castle && !prev.castle) seen.set(t.to, t); // castling wins over a stride
    else if (prev.usedJump && !t.usedJump) seen.set(t.to, t); // prefer not spending the blessing
    else if (prev.stride && !t.stride && !prev.castle) seen.set(t.to, t);
  }
  return [...seen.values()];
}

/** Generates slide targets for spells such as „Bástyatöltés” (limited range). */
export function slideTargets(state: GameState, s: Square, dirs: readonly Dir[], max: number): Target[] {
  const p = state.board[s];
  if (!p) return [];
  const ctx = buildCtx(state);
  const out: Target[] = [];
  genSlide(state, ctx, s, p.color, dirs, 'moves', out, { max });
  return out.filter((t) => !ctx.reserved.has(t.to));
}

export function knightTargets(state: GameState, s: Square): Target[] {
  const p = state.board[s];
  if (!p) return [];
  const ctx = buildCtx(state);
  const out: Target[] = [];
  genKnight(state, ctx, s, p.color, 'moves', out);
  return out.filter((t) => !ctx.reserved.has(t.to));
}

// ── Attacks & check ─────────────────────────────────────────────────────────

export function isSquareAttacked(state: GameState, ctx: RulesCtx, target: Square, by: Color): boolean {
  const board = state.board;
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (!p || p.color !== by) continue;
    if (fx(ctx, p.id, 'disarmed')) continue; // „Hatástalanítás”: its attacks do not count
    const ts = pieceTargets(state, ctx, s, 'attacks');
    for (const t of ts) if (t.to === target) return true;
  }
  return false;
}

export function inCheck(state: GameState, color: Color, ctx: RulesCtx = buildCtx(state)): boolean {
  const k = findKing(state.board, color);
  if (k < 0) return false;
  return isSquareAttacked(state, ctx, k, opposite(color));
}

/** Check status once every effect that ends with the current turn has expired. */
export function inCheckAfterTurnEnd(state: GameState, color: Color): boolean {
  if (!geometryChangesAtTurnEnd(state)) return false;
  const copy = cloneForSim(state);
  applyTurnEndChanges(copy); // mines explode, stepped-aside pieces return
  expireEffects(copy, copy.turnIndex);
  return inCheck(copy, color);
}

/** The position as it will look once the current turn ends (mines exploded, pieces returned, effects expired). */
export function projectTurnEnd(state: GameState): GameState {
  const copy = cloneForSim(state);
  applyTurnEndChanges(copy);
  expireEffects(copy, copy.turnIndex);
  return copy;
}

/** King is safe right now AND stays safe when this turn's effects expire. */
export function isSafe(state: GameState, color: Color): boolean {
  return !inCheck(state, color) && !inCheckAfterTurnEnd(state, color);
}

// ── Applying a move to a board (shared by real moves, spells and simulation) ──

export interface RawMoveResult {
  piece: Piece;
  captured: Piece | null;
  bounced: boolean;
  promotes: boolean;
  capturedSquare: Square | null;
  /** A „Klón” captured and dissolved (it is no longer on the board). */
  cloneVanished: boolean;
  /** „Üvegátok”: the capturing piece was cursed and broke right after its capture. */
  shattered: { owner: Color; mage: boolean } | null;
}

/**
 * Mutates `state` by performing the move on the board. Handles captures (including
 * „Megerősítés” bounces and „Halálbélyeg”), castling, en passant and blessing use.
 * No logging, mana or turn handling – callers add that.
 */
export function applyMoveRaw(state: GameState, move: Move | Target & { from: Square }): RawMoveResult {
  const board = state.board;
  const p = board[move.from]!;
  const res: RawMoveResult = { piece: p, captured: null, bounced: false, promotes: false, capturedSquare: null, cloneVanished: false, shattered: null };
  if ('defuse' in move && move.defuse) {
    // „Akna”: the king defuses the neighbouring mine and stays where it is.
    removeMinesAt(state, move.to);
    return res;
  }
  if (move.capture) {
    const capSq = move.captureSquare ?? move.to;
    const target = board[capSq];
    if (target) {
      const marked = state.effects.some((e) => e.kind === 'deathMark' && e.pieceId === target.id && e.owner === p.color);
      if (!marked) {
        const shields = state.effects
          .filter((e) => e.kind === 'fortified' && e.pieceId === target.id)
          .sort((a, b) => (a.expiresAfterTurn ?? 1e9) - (b.expiresAfterTurn ?? 1e9));
        if (shields.length) {
          removeEffect(state, shields[0].id);
          res.bounced = true;
          res.capturedSquare = capSq;
          return res; // attacker stays where it was
        }
      }
      board[capSq] = null;
      state.captured[target.color].push({ ...target });
      removePieceEffects(state, target.id);
      res.captured = target;
      res.capturedSquare = capSq;
    }
  }
  if (move.ranged) {
    // „Futólövész”: the shooter never leaves its square.
    if (res.captured && p.clone) dissolveClone(state, res, p, move.from);
    else if (res.captured) shatterIfCursed(state, res, p, move.from);
    return res;
  }
  board[move.to] = p;
  if (move.to !== move.from) board[move.from] = null;
  p.prevSquare = move.from;
  p.hasMoved = true;
  if (p.type === 'K') removeMinesAt(state, move.to); // a king stepping on a mine defuses it
  if (move.castle) {
    const br = rankOf(move.from);
    const rFrom = sq(move.castle === 'K' ? 7 : 0, br);
    const rTo = sq(move.castle === 'K' ? 5 : 3, br);
    const rook = board[rFrom];
    if (rook) {
      board[rTo] = rook;
      board[rFrom] = null;
      rook.prevSquare = rFrom;
      rook.hasMoved = true;
    }
  }
  if (move.usedJump) {
    const bl = state.effects.find((e) => e.kind === 'bishopBlessing' && e.pieceId === p.id);
    if (bl) removeEffect(state, bl.id);
  }
  if (p.type === 'P' && move.doubleStep) {
    const mid = (move.from + move.to) / 2;
    state.ep = { target: mid, pawnSquare: move.to, pawnId: p.id, turn: state.turnIndex + 1 };
  }
  if (p.type === 'P' && rankOf(move.to) === promotionRank(p.color)) res.promotes = true;
  if (res.captured && p.clone) dissolveClone(state, res, p, move.to);
  else if (res.captured) shatterIfCursed(state, res, p, move.to);
  return res;
}

function removeMinesAt(state: GameState, s: Square) {
  state.effects = state.effects.filter((e) => !(e.kind === 'mine' && e.squares?.includes(s)));
}

/**
 * „Üvegátok”: a cursed piece that captured something breaks right after the capture. It is
 * part of the move itself, so the legality check sees it too (the freed square may expose the
 * mover's own king). Nothing guards against it: it is not a capture, the piece breaks itself.
 */
function shatterIfCursed(state: GameState, res: RawMoveResult, p: Piece, at: Square) {
  const curse = state.effects.find((e) => e.kind === 'glassCursed' && e.pieceId === p.id);
  if (!curse) return;
  const mage = state.effects.some((e) => e.kind === 'manaMage' && e.pieceId === p.id);
  state.board[at] = null;
  state.captured[p.color].push({ ...p, shattered: true });
  removePieceEffects(state, p.id);
  res.shattered = { owner: curse.owner, mage };
  res.promotes = false;
}

/** „Klón”: a clone that captured something dissolves immediately. */
function dissolveClone(state: GameState, res: RawMoveResult, p: Piece, at: Square) {
  state.board[at] = null;
  state.captured[p.color].push({ ...p, dissolved: true });
  removePieceEffects(state, p.id);
  res.cloneVanished = true;
  res.promotes = false;
}

// ── Legal normal moves ──────────────────────────────────────────────────────

function toMove(from: Square, p: Piece, t: Target): Move {
  const m: Move = { from, to: t.to };
  if (t.capture) m.capture = true;
  if (t.captureSquare !== undefined) m.captureSquare = t.captureSquare;
  if (t.enPassant) m.enPassant = true;
  if (t.castle) m.castle = t.castle;
  if (t.doubleStep) m.doubleStep = true;
  if (t.usedJump) m.usedJump = true;
  if (t.stride) m.stride = true;
  if (t.ranged) m.ranged = true;
  if (p.type === 'P' && rankOf(t.to) === promotionRank(p.color)) m.promotion = true;
  return m;
}

/** Simulate a normal move and return the resulting (uncommitted) state. */
export function simulateMove(state: GameState, move: Move): GameState {
  const copy = cloneForSim(state);
  const r = applyMoveRaw(copy, move);
  // a promotion is judged as the strongest piece the pawn may still become („Végzet” may have taken some)
  if (r.promotes && !r.bounced) r.piece.type = promotionChoices(copy, r.piece.color)[0] ?? 'Q';
  return copy;
}

function isMoveLegal(state: GameState, ctx: RulesCtx, move: Move, color: Color): boolean {
  const opp = opposite(color);
  if (move.castle) {
    if (inCheck(state, color, ctx)) return false;
    const br = rankOf(move.from);
    const pass = sq(move.castle === 'K' ? 5 : 3, br);
    if (isSquareAttacked(state, ctx, pass, opp)) return false;
  }
  if (move.stride) {
    const mid = (move.from + move.to) / 2;
    if (isSquareAttacked(state, ctx, mid, opp)) return false;
  }
  const after = simulateMove(state, move);
  if (!isSafe(after, color)) return false;
  // „Királyvédelem”: the protected side may not be put in check.
  if (colorHas(state, opp, 'royalGuard') && inCheck(after, opp)) return false;
  return true;
}

export interface MoveOptions {
  /** Ignore the turn-phase checks (used by perft/AI helpers). */
  ignorePhase?: boolean;
}

/** All legal normal chess moves of the side to move, honouring every effect. */
export function legalMoves(state: GameState, opts: MoveOptions = {}): Move[] {
  if (state.status.kind !== 'playing' || state.pendingPromotion) return [];
  const color = state.turn;
  const ts = state.turnState;
  if (!opts.ignorePhase) {
    if (ts.normalMoveDone && !ts.bonusMoveAvailable) return [];
    // „Időmegállítás”: no normal move – unless the king is in danger.
    if (colorHas(state, color, 'timeStop') && isSafe(state, color)) return [];
  }
  const ctx = buildCtx(state);
  const moves: Move[] = [];
  for (let s = 0; s < 64; s++) {
    const p = state.board[s];
    if (!p || p.color !== color) continue;
    moves.push(...legalMovesFromSquare(state, ctx, s, opts));
  }
  return provokedOnly(state, moves);
}

/** „Provokáció”: if a provoked piece of the side to move can move, the normal move must be made with it. */
export function provokedSquares(state: GameState): Square[] {
  if (state.turnState.normalMoveDone) return [];
  const ids = new Set(state.effects.filter((e) => e.kind === 'provoked' && e.pieceId).map((e) => e.pieceId!));
  if (!ids.size) return [];
  const out: Square[] = [];
  state.board.forEach((p, s) => {
    if (p && p.color === state.turn && ids.has(p.id)) out.push(s);
  });
  return out;
}

function provokedOnly(state: GameState, moves: Move[]): Move[] {
  const forced = provokedSquares(state);
  if (!forced.length) return moves;
  const own = moves.filter((m) => forced.includes(m.from));
  return own.length ? own : moves;
}

/** Legal moves of the piece on `s` ignoring the turn phase and „Provokáció” (used by spells, e.g. „Gyorssánc”). */
export function pieceLegalMoves(state: GameState, s: Square): Move[] {
  const p = state.board[s];
  if (!p) return [];
  return legalMovesFromSquare(state, buildCtx(state), s, { ignorePhase: true });
}

export function legalMovesFrom(state: GameState, s: Square): Move[] {
  return legalMoves(state).filter((m) => m.from === s);
}

function legalMovesFromSquare(state: GameState, ctx: RulesCtx, s: Square, opts: MoveOptions): Move[] {
  const p = state.board[s]!;
  const color = p.color;
  const ts = state.turnState;
  if (!opts.ignorePhase && ts.bonusMoveAvailable && p.id === ts.firstMovePieceId) return [];
  if (fx(ctx, p.id, 'weakened') || fx(ctx, p.id, 'frozen') || fx(ctx, p.id, 'outOfWay')) return [];
  const rooted = fx(ctx, p.id, 'rooted');
  const noCapture = fx(ctx, p.id, 'blinded') || fx(ctx, p.id, 'disarmed');
  // „Végzet” took every piece a pawn could become: it may not step onto the last rank at all
  const noPromotion = p.type === 'P' && promotionChoices(state, color).length === 0;
  const out: Move[] = [];
  for (const t of pieceTargets(state, ctx, s, 'moves')) {
    if (rooted && !t.capture) continue;
    if (noCapture && t.capture) continue;
    if (p.type === 'P' && !pawnSquareOk(color, t.to) && rankOf(t.to) !== promotionRank(color)) continue;
    if (noPromotion && rankOf(t.to) === promotionRank(color)) continue;
    const m = toMove(s, p, t);
    if (!isMoveLegal(state, ctx, m, color)) continue;
    out.push(m);
  }
  // „Akna”: a king may defuse a mine next to it as its move (if it cannot simply step onto it).
  if (p.type === 'K' && ctx.mines.size) {
    for (const mSq of ctx.mines) {
      if (chebyshev(s, mSq) !== 1 || out.some((m) => m.to === mSq)) continue;
      const m: Move = { from: s, to: mSq, defuse: true };
      if (isMoveLegal(state, ctx, m, color)) out.push(m);
    }
  }
  return out;
}

export function hasLegalMove(state: GameState): boolean {
  if (state.status.kind !== 'playing' || state.pendingPromotion) return false;
  const color = state.turn;
  const ts = state.turnState;
  if (ts.normalMoveDone && !ts.bonusMoveAvailable) return false;
  if (colorHas(state, color, 'timeStop') && isSafe(state, color)) return false;
  const ctx = buildCtx(state);
  for (let s = 0; s < 64; s++) {
    const p = state.board[s];
    if (!p || p.color !== color) continue;
    if (legalMovesFromSquare(state, ctx, s, {}).length) return true;
  }
  return false;
}

/** Does `color`'s side currently give check to the opponent? */
export function givesCheck(state: GameState, color: Color): boolean {
  return inCheck(state, opposite(color));
}
