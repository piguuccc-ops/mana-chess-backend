import type { GameState } from './types';

/**
 * Deterministic PRNG (mulberry32). The seed lives in the GameState, so replaying
 * the same actions always yields the same result – a requirement for online play.
 */
export function nextRandom(state: GameState): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomInt(state: GameState, maxExclusive: number): number {
  return Math.floor(nextRandom(state) * maxExclusive);
}

export function randomSeed(): number {
  return (Math.random() * 2 ** 31) | 0;
}
