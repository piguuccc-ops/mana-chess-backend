import type { Color, Effect, EffectKind, GameState, Square } from './types';

export function addEffect(state: GameState, e: Omit<Effect, 'id'>): Effect {
  const eff: Effect = { ...e, id: `e${state.nextId++}` };
  state.effects.push(eff);
  return eff;
}

export function removeEffect(state: GameState, id: string): void {
  state.effects = state.effects.filter((e) => e.id !== id);
}

export function removePieceEffects(state: GameState, pieceId: string): void {
  state.effects = state.effects.filter((e) => e.pieceId !== pieceId);
}

export function pieceEffects(state: GameState, pieceId: string, kind?: EffectKind): Effect[] {
  return state.effects.filter((e) => e.pieceId === pieceId && (!kind || e.kind === kind));
}

export function pieceHas(state: GameState, pieceId: string, kind: EffectKind): boolean {
  return state.effects.some((e) => e.pieceId === pieceId && e.kind === kind);
}

/** Colour-scoped effect (e.g. silenced, timeStop, doubleMove) applying to `color`. */
export function colorHas(state: GameState, color: Color, kind: EffectKind): boolean {
  return state.effects.some((e) => e.kind === kind && e.color === color);
}

export function colorEffect(state: GameState, color: Color, kind: EffectKind): Effect | undefined {
  return state.effects.find((e) => e.kind === kind && e.color === color);
}

export function globalHas(state: GameState, kind: EffectKind): boolean {
  return state.effects.some((e) => e.kind === kind);
}

/** Effects whose removal changes which squares are attacked. */
export const GEOMETRY_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>([
  'wall',
  'gravity',
  'dimensionZone',
  'realityBreak',
  'queenGrace',
  'bishopBlessing',
  'disarmed',
  'mine',
  'outOfWay',
]);

export function expiringAtEndOf(state: GameState, turn: number): Effect[] {
  return state.effects.filter((e) => e.expiresAfterTurn !== null && e.expiresAfterTurn <= turn);
}

/** Removes every effect that ends with `turn`. Returns the removed effects. */
export function expireEffects(state: GameState, turn: number): Effect[] {
  const gone = expiringAtEndOf(state, turn);
  if (gone.length) state.effects = state.effects.filter((e) => !gone.includes(e));
  return gone;
}

/** Does any geometry-changing effect end with the current turn? */
export function geometryChangesAtTurnEnd(state: GameState): boolean {
  return state.effects.some(
    (e) => e.expiresAfterTurn !== null && e.expiresAfterTurn <= state.turnIndex && GEOMETRY_KINDS.has(e.kind),
  );
}

/** Pre-computed lookup tables for move generation. */
export interface RulesCtx {
  walls: Set<Square>;
  zone: Set<Square>;
  gravity: boolean;
  realityBreak: Record<Color, boolean>;
  pieceFx: Map<string, Set<EffectKind>>;
  /** pieceId → colours that have a death mark on it. */
  marks: Map<string, Set<Color>>;
  /** „El az útból!”: home squares that nobody may move onto this turn (passing through is fine). */
  reserved: Set<Square>;
  /** „Akna”: squares with a live mine. */
  mines: Set<Square>;
}

export function buildCtx(state: GameState): RulesCtx {
  const ctx: RulesCtx = {
    walls: new Set(),
    zone: new Set(),
    gravity: false,
    realityBreak: { w: false, b: false },
    pieceFx: new Map(),
    marks: new Map(),
    reserved: new Set(),
    mines: new Set(),
  };
  for (const e of state.effects) {
    switch (e.kind) {
      case 'wall':
        e.squares?.forEach((s) => ctx.walls.add(s));
        break;
      case 'dimensionZone':
        e.squares?.forEach((s) => ctx.zone.add(s));
        break;
      case 'gravity':
        ctx.gravity = true;
        break;
      case 'outOfWay':
        if (e.squares?.length) ctx.reserved.add(e.squares[0]);
        break;
      case 'mine':
        e.squares?.forEach((s) => ctx.mines.add(s));
        break;
      case 'realityBreak':
        if (e.color) ctx.realityBreak[e.color] = true;
        break;
      case 'deathMark':
        if (e.pieceId) {
          if (!ctx.marks.has(e.pieceId)) ctx.marks.set(e.pieceId, new Set());
          ctx.marks.get(e.pieceId)!.add(e.owner);
        }
        break;
      default:
        break;
    }
    if (e.pieceId) {
      if (!ctx.pieceFx.has(e.pieceId)) ctx.pieceFx.set(e.pieceId, new Set());
      ctx.pieceFx.get(e.pieceId)!.add(e.kind);
    }
  }
  return ctx;
}

export const fx = (ctx: RulesCtx, pieceId: string, kind: EffectKind): boolean =>
  ctx.pieceFx.get(pieceId)?.has(kind) ?? false;

export const markedBy = (ctx: RulesCtx, pieceId: string, c: Color): boolean =>
  ctx.marks.get(pieceId)?.has(c) ?? false;
