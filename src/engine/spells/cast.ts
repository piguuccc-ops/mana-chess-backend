// ─────────────────────────────────────────────────────────────────────────────
// Generic spell-casting framework: mana, silence, time stop, the cycle, target
// validation by simulation, king-safety checks, logging and events.
// ─────────────────────────────────────────────────────────────────────────────
import { opposite, squareName } from '../board';
import { COLOR_NAME_HU, HAND_SIZE } from '../constants';
import { colorEffect, colorHas, removeEffect } from '../effects';
import { addLog, emit } from '../log';
import { loseMana } from '../mana';
import { cloneState, hasLegalMove, inCheck, isSafe } from '../movegen';
import { canEndTurn, normalMoveAvailable } from '../rules';
import type { Color, GameState, SpellId, Square } from '../types';
import { wardedAgainst } from './helpers';
import { SPELLS } from './index';
import type { Spell, SpellContext } from './types';

const ctxFor = (state: GameState, caster: Color = state.turn): SpellContext => ({ state, caster, opp: opposite(caster) });

/**
 * „Körforgás”: is this card awakened for `color` – has it been played often enough in its plain
 * form since its last awakened cast?
 */
export function isAwakened(state: GameState, color: Color, id: SpellId): boolean {
  const need = SPELLS[id]?.cycles;
  return !!need && (state.players[color].charges[id] ?? 0) >= need;
}

/** How far a card with an awakened form has charged: plain casts so far and the number needed. */
export function chargeOf(state: GameState, color: Color, id: SpellId): { have: number; need: number } | null {
  const need = SPELLS[id]?.cycles;
  return need ? { have: Math.min(need, state.players[color].charges[id] ?? 0), need } : null;
}

/** Mana cost after „Túltöltés” (minimum 1). */
export function effectiveCost(state: GameState, color: Color, spell: Spell, targets?: Square[]): number {
  const base =
    spell.costFor && targets && targets.length ? spell.costFor(ctxFor(state, color), targets) : spell.manaCost;
  const disc = colorEffect(state, color, 'discount');
  if (!disc) return base;
  return Math.max(1, base - (disc.value ?? 2));
}

// Memoisation: GameStates are immutable once committed, so results can be cached per object.
const cache = new WeakMap<GameState, Map<string, unknown>>();
function memo<T>(state: GameState, key: string, fn: () => T): T {
  let m = cache.get(state);
  if (!m) cache.set(state, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = fn();
  m.set(key, v);
  return v;
}

/** Framework-level reasons a spell cannot be cast (ignores targets). */
function basicBlockReason(state: GameState, spellId: SpellId): string | null {
  const spell = SPELLS[spellId];
  const c = state.turn;
  if (state.status.kind !== 'playing') return 'A játszma véget ért.';
  if (state.pendingPromotion) return 'Előbb fejezd be a gyalogátváltozást.';
  const pl = state.players[c];
  if (!pl.deck.slice(0, HAND_SIZE).includes(spellId)) return 'Ez a spell nincs a kezedben.';
  if (colorHas(state, c, 'silenced')) return 'Némaság: ebben a körben nem használhatsz spellt.';
  if (colorHas(state, c, 'timeStop') && state.turnState.spellsCast >= 1)
    return 'Időmegállítás: ebben a körben csak egy spellt használhatsz.';
  const cost = effectiveCost(state, c, spell);
  if (pl.mana < cost) return `Nincs elég mana (${cost} kell).`;
  if (spell.beforeMoveOnly && state.turnState.normalMoveDone) return 'Csak a normál lépésed előtt használható.';
  if (spell.needsNormalMove && !normalMoveAvailable(state)) return 'Már nincs normál lépésed ebben a körben.';
  if (spell.canCast && !spell.canCast(ctxFor(state))) return 'A spell feltételei most nem teljesülnek.';
  return null;
}

/**
 * Runs the spell on a copy of the state. Returns the new state, or null if the
 * outcome would be illegal (e.g. it leaves the caster's king in check).
 */
export function simulateCast(state: GameState, spellId: SpellId, targets: Square[]): GameState | null {
  const spell = SPELLS[spellId];
  const caster = state.turn;
  const opp = opposite(caster);
  const draft = cloneState(state);
  const pl = draft.players[caster];
  const cost = effectiveCost(draft, caster, spell, targets);
  if (pl.mana < cost) return null; // target-dependent price not affordable
  const awakened = isAwakened(state, caster, spellId);
  // 1) pay immediately
  loseMana(draft, caster, cost, spell.name);
  const disc = colorEffect(draft, caster, 'discount');
  if (disc && spell.id !== 'overcharge') removeEffect(draft, disc.id);
  // 2) cycle: the used card goes to the back, the next one enters the hand
  const idx = pl.deck.indexOf(spellId);
  pl.deck.splice(idx, 1);
  pl.deck.push(spellId);
  pl.cycleCount++;
  emit(draft, { type: 'cycle', color: caster, used: spellId, drawn: pl.deck[HAND_SIZE - 1] ?? null });
  pl.spellsCast++;
  draft.turnState.spellsCast++;
  // „Körforgás”: a plain cast charges the card, the awakened cast spends the charge
  if (spell.cycles) pl.charges[spellId] = awakened ? 0 : Math.min(spell.cycles, (pl.charges[spellId] ?? 0) + 1);
  // 3) effect
  const before = draft.events.filter((e) => e.type === 'spell').length;
  const name = awakened && spell.awakened ? spell.awakened.name : spell.name;
  addLog(draft, caster, 'spell', `${COLOR_NAME_HU[caster]}: ${spell.icon} ${name}${targets.length ? ' → ' + targets.map(squareName).join(', ') : ''}`, spellId);
  const mages = draft.effects.filter((e) => e.kind === 'manaMage' && e.pieceId);
  try {
    spell.execute({ state: draft, caster, opp, awakened }, targets);
  } catch {
    return null;
  }
  // „Mana mágus” killed by a spell → the player who cast that spell loses 1 mana at once.
  for (const e of mages) {
    if (draft.board.some((p) => p?.id === e.pieceId)) continue;
    const owner = e.owner;
    // a clone that dissolved by itself, or a mage the curse broke („Üvegátok” charges the curse's owner)
    if (draft.captured[owner].some((p) => p.id === e.pieceId && (p.dissolved || p.shattered))) continue;
    const lost = loseMana(draft, caster, 1, 'Mana mágus megölése');
    addLog(draft, caster, 'mana', `${COLOR_NAME_HU[caster]} spellel ölte meg a mana mágust${lost ? ': −1 mana' : ' (nem volt több manája)'}.`);
  }
  if (draft.events.filter((e) => e.type === 'spell').length === before) {
    emit(draft, { type: 'spell', spellId, color: caster, squares: targets, ...(awakened ? { awakened: true } : {}) });
  }
  if (spell.cycles && !awakened && isAwakened(draft, caster, spellId)) {
    addLog(draft, caster, 'system', `${spell.name}: a lap feltöltődött – amikor legközelebb a kezedbe kerül, felébredve játszhatod ki.`);
  }
  // 4) legality
  const safeBefore = isSafe(state, caster);
  if (spell.requireKingSafe) {
    if (!isSafe(draft, caster)) return null;
  } else if (safeBefore && !isSafe(draft, caster)) return null;
  if (colorHas(state, opp, 'royalGuard') && !inCheck(state, opp) && inCheck(draft, opp)) return null;
  return draft;
}

function completable(state: GameState, spell: Spell, picked: Square[]): boolean {
  return memo(state, `c:${spell.id}:${picked.join(',')}`, () => {
    if (picked.length === spell.steps.length) return simulateCast(state, spell.id, picked) !== null;
    const cands = (spell.getTargets ? spell.getTargets(ctxFor(state), picked) : []).filter(
      (t) => spell.ignoresWard || !wardedAgainst(state, t, state.turn),
    );
    if (spell.fastTargets) {
      // Independent targets (e.g. „Brigád”): one representative completion is enough.
      const need = spell.steps.length - picked.length;
      const rest = cands.filter((t) => !picked.includes(t));
      return rest.length >= need && simulateCast(state, spell.id, [...picked, ...rest.slice(0, need)]) !== null;
    }
    return cands.some((t) => !picked.includes(t) && completable(state, spell, [...picked, t]));
  });
}

/** Valid squares for the next target step (only ones that lead to a legal cast). */
export function validTargets(state: GameState, spellId: SpellId, picked: Square[]): Square[] {
  const spell = SPELLS[spellId];
  if (picked.length >= spell.steps.length || !spell.getTargets) return [];
  return memo(state, `t:${spellId}:${picked.join(',')}`, () =>
    spell.getTargets!(ctxFor(state), picked).filter(
      (t) =>
        !picked.includes(t) &&
        (spell.ignoresWard || !wardedAgainst(state, t, state.turn)) &&
        completable(state, spell, [...picked, t]),
    ),
  );
}

/** Why the side to move cannot cast this spell (null → castable). */
export function castBlockReason(state: GameState, spellId: SpellId): string | null {
  return memo(state, `b:${spellId}`, () => {
    const basic = basicBlockReason(state, spellId);
    if (basic) return basic;
    if (!completable(state, SPELLS[spellId], [])) {
      return SPELLS[spellId].steps.length ? 'Nincs érvényes célpont.' : 'A spell most nem használható (a királyod veszélybe kerülne).';
    }
    return null;
  });
}

export const canCast = (state: GameState, spellId: SpellId): boolean => castBlockReason(state, spellId) === null;

/** Validates and performs a cast. Returns the new state or an error message. */
export function performCast(state: GameState, spellId: SpellId, targets: Square[]): GameState | string {
  const spell = SPELLS[spellId];
  if (!spell) return 'Ismeretlen spell.';
  const reason = basicBlockReason(state, spellId);
  if (reason) return reason;
  if (targets.length !== spell.steps.length) return 'Hiányzó vagy felesleges célpont.';
  for (let i = 0; i < targets.length; i++) {
    if (!validTargets(state, spellId, targets.slice(0, i)).includes(targets[i])) return 'Érvénytelen célpont.';
  }
  const result = simulateCast(state, spellId, targets);
  if (!result) return 'A spell nem használható így: a királyod sakkban maradna / sakkba kerülne.';
  return result;
}

/** Enumerates every complete, legal target list of a spell (bounded). */
export function* targetCombos(state: GameState, spell: Spell, picked: Square[] = []): Generator<Square[]> {
  if (spell.fastTargets && picked.length === 0) {
    // Every candidate square appears at least once (e.g. a summoned blocker on each possible square).
    const cands = validTargets(state, spell.id, []);
    const need = spell.steps.length;
    for (const t of cands) {
      const rest = cands.filter((x) => x !== t).slice(0, need - 1);
      if (rest.length === need - 1) yield [t, ...rest];
    }
    return;
  }
  if (picked.length === spell.steps.length) {
    yield picked;
    return;
  }
  for (const t of validTargets(state, spell.id, picked)) yield* targetCombos(state, spell, [...picked, t]);
}

/**
 * Checkmate/stalemate helper: can the side to move escape its situation with one
 * spell (after which it has a legal move or may end the turn)?
 */
export function spellEscapeExists(state: GameState): boolean {
  const c = state.turn;
  for (const id of state.players[c].deck.slice(0, HAND_SIZE)) {
    if (castBlockReason(state, id) !== null) continue;
    for (const targets of targetCombos(state, SPELLS[id])) {
      const after = simulateCast(state, id, targets);
      if (!after) continue;
      if (after.pendingPromotion) return true;
      if (hasLegalMove(after) || canEndTurn(after)) return true;
    }
  }
  return false;
}
