import type { SpellId } from '../types';
import { REMOVED_SPELLS, SPELL_LIST } from './definitions';
import type { Spell, SpellCategory } from './types';

export type { Spell, SpellCategory, SpellContext, TargetStep, TargetType } from './types';
export { REMOVED_SPELLS, SPELL_LIST };
export { BRIGADE_SIZE, METEOR_BUDGET, DRAGON_FIRE_BUDGET, MANA_DEPOSIT_RETURN, SKIPPED_PROPOSALS } from './definitions';

export const SPELLS: Record<SpellId, Spell> = Object.fromEntries(SPELL_LIST.map((s) => [s.id, s])) as Record<SpellId, Spell>;

export const getSpell = (id: SpellId): Spell => {
  const s = SPELLS[id];
  if (!s) throw new Error(`Unknown spell: ${id}`);
  return s;
};

export const CATEGORY_ORDER: SpellCategory[] = ['Mozgás', 'Védelem', 'Irányítás', 'Taktika', 'Terep', 'Idő', 'Mana', 'Pusztítás'];
