import { DECK_SIZE } from './constants';
import { SPELLS, SPELL_LIST } from './spells';
import type { SpellId } from './types';

export interface DeckDef {
  id: string;
  name: string;
  description: string;
  spells: SpellId[];
  preset?: boolean;
}

export const PRESET_DECKS: DeckDef[] = [
  {
    id: 'preset-classic', name: 'Klasszikus', preset: true,
    description: 'Kiegyensúlyozott kezdőpakli: egy kis védelem, egy kis mozgás, egy kis trükk.',
    spells: ['pawnShield', 'knightLeap', 'weaken', 'forcedMarch', 'fortify', 'instantPromotion'],
  },
  {
    id: 'preset-blitz', name: 'Villámroham', preset: true,
    description: 'Agresszív tempópakli ingyen lépésekkel és egy kivégzéssel a végére.',
    spells: ['pawnRush', 'knightLeap', 'deathMark', 'rookCharge', 'doubleMove', 'execution'],
  },
  {
    id: 'preset-fortress', name: 'Vasfal', preset: true,
    description: 'Védekező pakli: pajzsok, falak és vészkijáratok a királynak.',
    spells: ['pawnShield', 'fortify', 'wall', 'royalGuard', 'checkBreaker', 'lastChance'],
  },
  {
    id: 'preset-mana', name: 'Manamágus', preset: true,
    description: 'Gazdaság-pakli: gyorsan tölts fel, és zárd le a játékot egy Meteorral.',
    spells: ['sacrifice', 'arcaneSurge', 'overcharge', 'manaDrain', 'bloodPrice', 'meteor'],
  },
  {
    // Időmegállítás (5) made way for Vihar when a deck could hold only one 5-mana spell
    id: 'preset-chrono', name: 'Időmester', preset: true,
    description: 'Kontroll-pakli: fagyaszd le az ellenfelet, és tekerd vissza a legjobb lépéseit.',
    spells: ['silence', 'weaken', 'root', 'stepBack', 'storm', 'rewind'],
  },
  {
    id: 'preset-chaos', name: 'Káoszmágus', preset: true,
    description: 'Forgasd fel a táblát: cserék, tükrözés, földrengés és dimenzióváltás.',
    spells: ['mirror', 'gambit', 'chaos', 'earthquake', 'dimensionShift', 'realityBreak'],
  },
  {
    id: 'preset-sapper', name: 'Utászok', preset: true,
    description: 'Csapdák és lökdösődés: aknák, mágnes, taszítás – és egy provokáció, hogy belesétáljanak.',
    spells: ['provoke', 'outOfWay', 'magnet', 'repulse', 'mine', 'manaDeposit'],
  },
  {
    id: 'preset-dragon', name: 'Sárkányszív', preset: true,
    description: 'Nehéztüzérség: gyűjts manát, törd le a pajzsokat, aztán égess fel egy átlót.',
    spells: ['scout', 'manaThirst', 'invisibility', 'shieldBreaker', 'storm', 'dragonFire'],
  },
];

/**
 * Deck-building limit on the most expensive spells: a deck may hold at most this many cards of
 * each of these costs (the card's listed price) – one 6-mana and one 5-mana spell.
 */
export const COST_LIMITS: Readonly<Record<number, number>> = { 5: 1, 6: 1 };

const count = (n: number) => (n === 1 ? 'egy' : String(n));
const names = (ids: SpellId[]) => ids.map((s) => SPELLS[s].name).join(', ');

/** Why `id` cannot be added to the deck `spells` because of the cost limits (null: it can). */
export function costLimitReason(spells: SpellId[], id: SpellId): string | null {
  if (spells.includes(id)) return null;
  const cost = SPELLS[id].manaCost;
  const max = COST_LIMITS[cost];
  if (max === undefined) return null;
  const same = spells.filter((s) => SPELLS[s]?.manaCost === cost);
  return same.length >= max ? `Egy pakliban legfeljebb ${count(max)} ${cost} manás spell lehet – már benne van: ${names(same)}.` : null;
}

/** Size, duplicates, known spells – what a deck needs to exist at all (a saved deck that only breaks a cost limit can still be fixed). */
export function deckShapeError(spells: SpellId[]): string | null {
  if (spells.length !== DECK_SIZE) return `A paklinak pontosan ${DECK_SIZE} spellből kell állnia (most ${spells.length}).`;
  if (new Set(spells).size !== spells.length) return 'Ugyanaz a spell nem szerepelhet kétszer.';
  if (spells.some((s) => !SPELLS[s])) return 'Ismeretlen spell a pakliban.';
  return null;
}

/** Returns null if the deck is valid (playable), otherwise a human-readable reason. */
export function validateDeck(spells: SpellId[]): string | null {
  const shape = deckShapeError(spells);
  if (shape) return shape;
  for (const [c, max] of Object.entries(COST_LIMITS)) {
    const same = spells.filter((s) => SPELLS[s].manaCost === Number(c));
    if (same.length > max) return `Egy pakliban legfeljebb ${count(max)} ${c} manás spell lehet (most ${same.length}: ${names(same)}).`;
  }
  return null;
}

/** Pseudo deck id: the menu stores this and a fresh random deck is dealt at every game start. */
export const RANDOM_DECK_ID = 'random';

/**
 * A random but still playable deck: 6 different spells within the cost limits (at most one 6-mana and
 * one 5-mana spell), at least 2 costing 1–2 mana, and the opening hand (first 3 cards) always contains
 * something castable from 3 mana.
 */
export function randomDeck(random: () => number = Math.random): SpellId[] {
  for (let attempt = 0; attempt < 500; attempt++) {
    const pool = SPELL_LIST.map((s) => s.id);
    const deck: SpellId[] = [];
    while (deck.length < DECK_SIZE && pool.length) {
      const id = pool.splice(Math.floor(random() * pool.length), 1)[0];
      if (costLimitReason(deck, id) === null) deck.push(id);
    }
    const costs = deck.map((id) => SPELLS[id].manaCost);
    if (deck.length < DECK_SIZE || costs.filter((c) => c <= 2).length < 2) continue;
    if (!costs.slice(0, 3).some((c) => c <= 3)) {
      const cheap = costs.findIndex((c) => c <= 3);
      [deck[0], deck[cheap]] = [deck[cheap], deck[0]];
    }
    return deck;
  }
  return [...PRESET_DECKS[0].spells];
}
