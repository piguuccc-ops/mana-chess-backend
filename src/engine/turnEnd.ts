// ─────────────────────────────────────────────────────────────────────────────
// Board changes that happen automatically when a turn ends:
//  • „Akna”: mines whose time is up explode,
//  • „El az útból!”: pieces that stepped aside return to their home square.
// Used both for real (game.ts → endTurn) and in simulation (king safety after the
// turn ends), so it only touches board / effects / captured – no logs or events.
// ─────────────────────────────────────────────────────────────────────────────
import { removeEffect, removePieceEffects } from './effects';
import type { Color, GameState, Piece, Square } from './types';

export type TurnEndChange =
  | {
      kind: 'explode';
      square: Square;
      owner: Color;
      /** Piece destroyed by the blast (null: empty square, king, or protection absorbed it). */
      destroyed: Piece | null;
      /** A shield / fortification absorbed the blast (and was used up). */
      absorbedBy: Piece | null;
      /** The destroyed piece was a „Mana mágus”. */
      mage: boolean;
    }
  | { kind: 'return'; piece: Piece; from: Square; to: Square }
  | { kind: 'stuck'; piece: Piece; at: Square };

const endsNow = (state: GameState, e: GameState['effects'][number]) =>
  e.expiresAfterTurn !== null && e.expiresAfterTurn <= state.turnIndex;

export function applyTurnEndChanges(state: GameState): TurnEndChange[] {
  const out: TurnEndChange[] = [];
  // 1) Mines explode (a piece that stepped aside with „El az útból!” dodges the blast).
  for (const e of state.effects.filter((x) => x.kind === 'mine' && endsNow(state, x))) {
    removeEffect(state, e.id);
    const s = e.squares?.[0];
    if (s === undefined) continue;
    const victim = state.board[s];
    const change: TurnEndChange = { kind: 'explode', square: s, owner: e.owner, destroyed: null, absorbedBy: null, mage: false };
    out.push(change);
    if (!victim || victim.type === 'K') continue;
    const marked = state.effects.some((x) => x.kind === 'deathMark' && x.pieceId === victim.id && x.owner === e.owner);
    const guards = state.effects.filter((x) => x.pieceId === victim.id && (x.kind === 'immune' || x.kind === 'fortified'));
    if (guards.length && !marked) {
      // Shield / fortification saves the piece but is destroyed by the blast.
      for (const g of guards) removeEffect(state, g.id);
      change.absorbedBy = victim;
      continue;
    }
    change.mage = state.effects.some((x) => x.kind === 'manaMage' && x.pieceId === victim.id);
    state.board[s] = null;
    state.captured[victim.color].push({ ...victim });
    removePieceEffects(state, victim.id);
    change.destroyed = victim;
  }
  // 2) Pieces that stepped out of the way go home.
  for (const e of state.effects.filter((x) => x.kind === 'outOfWay' && endsNow(state, x))) {
    removeEffect(state, e.id);
    const home = e.squares?.[0];
    const from = state.board.findIndex((p) => p?.id === e.pieceId);
    if (home === undefined || from < 0 || from === home) continue;
    const p = state.board[from]!;
    if (state.board[home]) {
      out.push({ kind: 'stuck', piece: p, at: from });
      continue;
    }
    state.board[home] = p;
    state.board[from] = null;
    if (e.restore) {
      p.hasMoved = e.restore.hasMoved;
      p.prevSquare = e.restore.prevSquare;
    }
    out.push({ kind: 'return', piece: p, from, to: home });
  }
  return out;
}
