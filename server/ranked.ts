// ─────────────────────────────────────────────────────────────────────────────
// Matchmaking for ranked games: the players who asked for an opponent, and who plays whom.
//
// The longest-waiting player is served first, with the closest rating inside the range both
// sides accept. The range starts at ±100 points and widens by 50 every five seconds; after a
// minute anyone will do (a small server would otherwise leave people waiting for ever). A
// player whose page stops asking about the queue is dropped from it after a few seconds.
// ─────────────────────────────────────────────────────────────────────────────
import type { SpellId } from '../src/engine';
import { queueRange, type QueueView } from '../src/net/protocol';

/** A page in the queue asks for news every few seconds; one silent for this long has gone. */
export const QUEUE_STALE_MS = 15_000;

export interface Waiting {
  userId: string;
  deck: SpellId[];
  deckName: string;
  /** When they joined (the range widens with the wait). */
  since: number;
  /** When their page last asked (left the queue when this gets old). */
  seen: number;
}

export class Matchmaker {
  private queue = new Map<string, Waiting>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Joins (or, already waiting, keeps the place in the queue with the new deck). */
  join(userId: string, deck: SpellId[], deckName: string): Waiting {
    const t = this.now();
    const old = this.queue.get(userId);
    const w: Waiting = { userId, deck, deckName, since: old?.since ?? t, seen: t };
    this.queue.set(userId, w);
    return w;
  }

  leave(userId: string): boolean {
    return this.queue.delete(userId);
  }

  has(userId: string): boolean {
    return this.queue.has(userId);
  }

  get size(): number {
    return this.queue.size;
  }

  /** The page asked about the queue: still here. */
  seen(userId: string): void {
    const w = this.queue.get(userId);
    if (w) w.seen = this.now();
  }

  view(userId: string): QueueView | null {
    const w = this.queue.get(userId);
    if (!w) return null;
    const waited = this.now() - w.since;
    return { waited: Math.floor(waited / 1000), range: queueRange(waited), searching: this.queue.size };
  }

  /** Removes the players whose pages went quiet; returns them. */
  sweep(): Waiting[] {
    const t = this.now();
    const gone = [...this.queue.values()].filter((w) => t - w.seen > QUEUE_STALE_MS);
    gone.forEach((w) => this.queue.delete(w.userId));
    return gone;
  }

  /**
   * The pairs that can play now (taken out of the queue). `rating` gives each player's current
   * rating; `canPlay` may veto a pair (e.g. someone already sitting at another board).
   */
  pairs(rating: (userId: string) => number, canPlay: (a: Waiting, b: Waiting) => boolean = () => true): [Waiting, Waiting][] {
    const t = this.now();
    const out: [Waiting, Waiting][] = [];
    const waiting = [...this.queue.values()].sort((a, b) => a.since - b.since);
    const taken = new Set<string>();
    for (const a of waiting) {
      if (taken.has(a.userId)) continue;
      const ra = rating(a.userId);
      const rangeA = queueRange(t - a.since);
      let best: Waiting | null = null;
      let bestGap = Infinity;
      for (const b of waiting) {
        if (b === a || taken.has(b.userId)) continue;
        const rb = rating(b.userId);
        const rangeB = queueRange(t - b.since);
        // the wider of the two ranges decides: a long wait on either side is enough
        const range = rangeA === null || rangeB === null ? Infinity : Math.max(rangeA, rangeB);
        const gap = Math.abs(ra - rb);
        if (gap > range || gap >= bestGap || !canPlay(a, b)) continue;
        best = b;
        bestGap = gap;
      }
      if (!best) continue;
      taken.add(a.userId);
      taken.add(best.userId);
      this.queue.delete(a.userId);
      this.queue.delete(best.userId);
      out.push([a, best]);
    }
    return out;
  }
}
