// ─────────────────────────────────────────────────────────────────────────────
// Spell-toborzás (a draft): 32 different spells, dealt at random from the whole game, are laid out
// on an 8 × 4 table. The players take one each, in turn (Világos first), until both have 6.
// A player's picks, in the order taken, are their deck – the first three are the opening hand.
// The usual deck rules hold: at most one 6-mana and one 5-mana spell per deck.
//
// Pure and deterministic (the table comes from a seed), so the server and the browsers agree.
// ─────────────────────────────────────────────────────────────────────────────
import { opposite } from './board';
import { DECK_SIZE } from './constants';
import { costLimitReason } from './decks';
import { SPELLS, SPELL_LIST } from './spells';
import type { Color, SpellId } from './types';

export const DRAFT_COLUMNS = 8;
export const DRAFT_ROWS = 4;
/** Spells on the table. */
export const DRAFT_POOL_SIZE = DRAFT_COLUMNS * DRAFT_ROWS;
/** At least this many cheap spells (1–2 mana) on the table, so both sides can build a castable start. */
export const DRAFT_CHEAP_MIN = 8;

export interface Draft {
  /** The spells on the table, row by row. */
  pool: SpellId[];
  /** Each side's picks so far, in the order taken (= the deck's order). */
  picks: Record<Color, SpellId[]>;
  /** Who takes the first card. */
  first: Color;
}

/** The engine's generator (mulberry32), started from a seed. */
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The table for a seed: 32 different spells, at least 8 of them costing 1–2 mana. */
export function draftPool(seed: number): SpellId[] {
  const random = seeded(seed);
  let pool: SpellId[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    const all = SPELL_LIST.map((s) => s.id);
    pool = [];
    while (pool.length < DRAFT_POOL_SIZE && all.length) pool.push(all.splice(Math.floor(random() * all.length), 1)[0]);
    if (pool.filter((id) => SPELLS[id].manaCost <= 2).length >= DRAFT_CHEAP_MIN) return pool;
  }
  return pool;
}

export function newDraft(seed: number, first: Color = 'w'): Draft {
  return { pool: draftPool(seed), picks: { w: [], b: [] }, first };
}

/** Whose pick it is; null when both decks are full (the draft is over). */
export function draftTurn(d: Draft): Color | null {
  const n = d.picks.w.length + d.picks.b.length;
  if (n >= DECK_SIZE * 2) return null;
  return n % 2 === 0 ? d.first : opposite(d.first);
}

export const draftDone = (d: Draft): boolean => draftTurn(d) === null;

/** Who has taken a spell (null: still on the table). */
export function takenBy(d: Draft, id: SpellId): Color | null {
  return d.picks.w.includes(id) ? 'w' : d.picks.b.includes(id) ? 'b' : null;
}

/** Why `color` can never take `id` (gone from the table, or it would break their deck's cost limit); null: it could. */
export function pickLimitReason(d: Draft, color: Color, id: SpellId): string | null {
  if (!d.pool.includes(id)) return 'Ez a spell nincs az asztalon.';
  const who = takenBy(d, id);
  if (who) return who === color ? 'Ez már a tiéd.' : 'Ezt a spellt már elvitték.';
  if (d.picks[color].length >= DECK_SIZE) return 'A paklid már teljes.';
  return costLimitReason(d.picks[color], id);
}

/** Why `color` cannot take `id` right now; null: they can. */
export function pickBlockReason(d: Draft, color: Color, id: SpellId): string | null {
  const who = draftTurn(d);
  if (who === null) return 'A toborzás véget ért.';
  if (who !== color) return 'Most nem te választasz.';
  return pickLimitReason(d, color, id);
}

/** The draft after `color` takes `id` (check `pickBlockReason` first). */
export function applyPick(d: Draft, color: Color, id: SpellId): Draft {
  return { ...d, picks: { ...d.picks, [color]: [...d.picks[color], id] } };
}

/** A draft received from the network: well-formed, consistent, and every pick legal in its turn. */
export function isValidDraft(v: unknown): v is Draft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Draft;
  if (d.first !== 'w' && d.first !== 'b') return false;
  if (!Array.isArray(d.pool) || d.pool.length !== DRAFT_POOL_SIZE || new Set(d.pool).size !== d.pool.length) return false;
  if (!d.pool.every((id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPELLS, id))) return false;
  if (!d.picks || !Array.isArray(d.picks.w) || !Array.isArray(d.picks.b)) return false;
  // replay the picks in turn order
  let replay: Draft = { pool: d.pool, picks: { w: [], b: [] }, first: d.first };
  const total = d.picks.w.length + d.picks.b.length;
  for (let i = 0; i < total; i++) {
    const who = draftTurn(replay);
    if (!who) return false;
    const id = d.picks[who][replay.picks[who].length];
    if (id === undefined || pickBlockReason(replay, who, id) !== null) return false;
    replay = applyPick(replay, who, id);
  }
  return true;
}
