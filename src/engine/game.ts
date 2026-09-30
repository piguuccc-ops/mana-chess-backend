// ─────────────────────────────────────────────────────────────────────────────
// Game orchestration: new game, the action reducer, turn flow and win/draw
// detection. `applyAction` is a pure function (old state is never mutated),
// which makes local play, AI search, replays and online sync straightforward.
// ─────────────────────────────────────────────────────────────────────────────
import { cloneBoard, opposite, parseFen, START_FEN, squareName } from './board';
import { COLOR_NAME_HU, FIFTY_MOVE_PLIES, MANA, PIECE_NAME_HU } from './constants';
import { colorEffect, expireEffects, globalHas, removeEffect } from './effects';
import { INTO_HU, isLostType } from './erasure';
import { addLog, emit } from './log';
import { gainMana, loseMana } from './mana';
import { captureBonuses, captureEarnsMana, isManaMage, reportShatter } from './pieceOps';
import { applyTurnEndChanges } from './turnEnd';
import {
  applyMoveRaw, cloneState, hasLegalMove, inCheck, inCheckAfterTurnEnd, legalMoves,
} from './movegen';
import { moveToSan, promotionSuffix } from './notation';
import { endTurnBlockReason } from './rules';
import { randomSeed } from './rng';
import { performCast, spellEscapeExists } from './spells/cast';
import type {
  Action, ActionResult, Color, GameState, Move, PromotionPiece, SpellId, TurnState,
} from './types';

export interface NewGameOptions {
  decks?: Partial<Record<Color, SpellId[]>>;
  deckNames?: Partial<Record<Color, string>>;
  fen?: string;
  seed?: number;
  mana?: Partial<Record<Color, number>>;
  /** Cards that start charged („Körforgás”) – scenario tests and puzzles. */
  charges?: Partial<Record<Color, Partial<Record<SpellId, number>>>>;
  /** See GameOptions.autoEndTurn (default true). */
  autoEndTurn?: boolean;
}

export const freshTurnState = (): TurnState => ({
  normalMoveDone: false,
  firstMovePieceId: null,
  bonusMoveAvailable: false,
  spellsCast: 0,
  irreversible: false,
});

export function createGame(opts: NewGameOptions = {}): GameState {
  const parsed = parseFen(opts.fen ?? START_FEN);
  const turnIndex = parsed.turn === 'w' ? 0 : 1;
  const state: GameState = {
    board: parsed.board,
    turn: parsed.turn,
    turnIndex,
    players: {
      w: {
        mana: opts.mana?.w ?? MANA.START, deck: [...(opts.decks?.w ?? [])], deckName: opts.deckNames?.w ?? 'Pakli',
        spellsCast: 0, captures: 0, cycleCount: 0, charges: { ...(opts.charges?.w ?? {}) },
      },
      b: {
        mana: opts.mana?.b ?? MANA.START, deck: [...(opts.decks?.b ?? [])], deckName: opts.deckNames?.b ?? 'Pakli',
        spellsCast: 0, captures: 0, cycleCount: 0, charges: { ...(opts.charges?.b ?? {}) },
      },
    },
    effects: [],
    ep: null,
    halfmoveClock: parsed.halfmove,
    captured: { w: [], b: [] },
    erased: [],
    snapshots: [],
    log: [],
    moveList: [],
    turnState: freshTurnState(),
    pendingPromotion: null,
    status: { kind: 'playing' },
    inCheck: false,
    mustCastSpell: false,
    rng: opts.seed ?? randomSeed(),
    nextId: parsed.nextId + 1,
    events: [],
    eventSeq: 0,
    options: { autoEndTurn: opts.autoEndTurn ?? true },
  };
  if (parsed.epTarget !== null) {
    const dir = parsed.turn === 'w' ? -8 : 8;
    const pawnSquare = parsed.epTarget + dir;
    const pawn = state.board[pawnSquare];
    if (pawn) state.ep = { target: parsed.epTarget, pawnSquare, pawnId: pawn.id, turn: turnIndex };
  }
  addLog(state, null, 'system', 'A játszma elkezdődött. Sok sikert!');
  evaluateStatus(state);
  return state;
}

// ── Status ──────────────────────────────────────────────────────────────────

function bareKingsDraw(state: GameState): boolean {
  const others = state.board.some((p) => p && p.type !== 'K');
  if (others) return false;
  const canRevive = (c: Color) =>
    state.players[c].deck.includes('necromancy') && state.captured[c].some((p) => p.type === 'P');
  return !canRevive('w') && !canRevive('b');
}

function finish(state: GameState, status: GameState['status'], text: string) {
  state.status = status;
  state.mustCastSpell = false;
  addLog(state, null, 'system', text);
  emit(state, { type: 'gameOver', status });
}

/** Re-evaluates check / checkmate / stalemate / draws for the side to move. */
export function evaluateStatus(state: GameState): void {
  if (state.status.kind !== 'playing' || state.pendingPromotion) return;
  const c = state.turn;
  const opp = opposite(c);
  if (state.halfmoveClock >= FIFTY_MOVE_PLIES) {
    finish(state, { kind: 'draw', reason: '50 lépéses szabály' }, 'Döntetlen: 50 lépés ütés és gyaloglépés nélkül.');
    return;
  }
  if (bareKingsDraw(state)) {
    finish(state, { kind: 'draw', reason: 'Elégtelen anyag' }, 'Döntetlen: csak a királyok maradtak.');
    return;
  }
  const checkNow = inCheck(state, c);
  const threatened = checkNow || inCheckAfterTurnEnd(state, c);
  if (checkNow && !state.inCheck) emit(state, { type: 'check', color: c });
  state.inCheck = threatened;
  if (hasLegalMove(state) || endTurnBlockReason(state) === null) {
    state.mustCastSpell = false;
    return;
  }
  if (spellEscapeExists(state)) {
    state.mustCastSpell = true;
    return;
  }
  if (threatened) {
    finish(state, { kind: 'checkmate', winner: opp }, `MATT! ${COLOR_NAME_HU[opp]} nyert.`);
  } else {
    finish(state, { kind: 'stalemate' }, 'Patt – döntetlen.');
  }
}

// ── Turn flow ───────────────────────────────────────────────────────────────

/** Mines explode and stepped-aside pieces return (with events and log lines). */
function resolveTurnEnd(state: GameState): void {
  for (const ch of applyTurnEndChanges(state)) {
    if (ch.kind === 'explode') {
      emit(state, { type: 'explode', square: ch.square });
      const where = squareName(ch.square);
      if (ch.destroyed) {
        emit(state, { type: 'destroy', square: ch.square, piece: { ...ch.destroyed } });
        state.turnState.irreversible = true;
        addLog(state, ch.owner, 'capture', `💣 Az akna felrobbant (${where}): elpusztult ${COLOR_NAME_HU[ch.destroyed.color].toLowerCase()} ${PIECE_NAME_HU[ch.destroyed.type]}.`);
        if (ch.mage) {
          const lost = loseMana(state, ch.owner, 1, 'Mana mágus megölése');
          addLog(state, ch.owner, 'mana', `Az akna mana mágust ölt${lost ? ': az akna gazdája −1 manát veszít' : ''}.`);
        }
      } else if (ch.absorbedBy) {
        emit(state, { type: 'shieldBlock', square: ch.square });
        addLog(state, ch.owner, 'capture', `💣 Az akna felrobbant (${where}), de a ${PIECE_NAME_HU[ch.absorbedBy.type]} védelme elnyelte – a pajzs/megerősítés megsemmisült.`);
      } else {
        addLog(state, ch.owner, 'system', `💣 Az akna felrobbant (${where}), de nem talált célt.`);
      }
    } else if (ch.kind === 'return') {
      emit(state, { type: 'move', pieceId: ch.piece.id, from: ch.from, to: ch.to });
      addLog(state, ch.piece.color, 'move', `El az útból!: a ${PIECE_NAME_HU[ch.piece.type]} visszatért (${squareName(ch.from)} → ${squareName(ch.to)}).`);
    } else {
      addLog(state, ch.piece.color, 'system', `El az útból!: a ${PIECE_NAME_HU[ch.piece.type]} nem tudott visszatérni (${squareName(ch.at)}).`);
    }
  }
}

/** „Mana-letét”: deposits made in the previous own turn pay out now. */
function payDeposits(state: GameState, color: Color): void {
  for (const e of state.effects.filter((x) => x.kind === 'manaDeposit' && x.color === color)) {
    removeEffect(state, e.id);
    const got = gainMana(state, color, e.value ?? 3, 'Mana-letét');
    addLog(state, color, 'mana', `Mana-letét: +${got} mana${got < (e.value ?? 3) ? ' (a többi elveszett)' : ''}.`);
  }
}

export function endTurn(state: GameState): void {
  const c = state.turn;
  const opp = opposite(c);
  resolveTurnEnd(state);
  state.halfmoveClock = state.turnState.irreversible ? 0 : state.halfmoveClock + 1;
  const expired = expireEffects(state, state.turnIndex);
  if (expired.some((e) => e.kind === 'wall')) addLog(state, null, 'system', 'A falak leomlottak.');
  state.turn = opp;
  state.turnIndex++;
  state.turnState = freshTurnState();
  state.inCheck = false;
  emit(state, { type: 'turn', color: opp });
  if (MANA.GRANT_ON_FIRST_TURN || state.turnIndex >= 2) {
    if (globalHas(state, 'manaFamine')) addLog(state, opp, 'mana', 'Mana-armageddon: ebben a körben nincs alap mana.');
    else gainMana(state, opp, MANA.PER_TURN, 'turn');
  }
  payManaMages(state, opp);
  payDeposits(state, opp);
  evaluateStatus(state);
}

/** „Mana mágus”: every living mage of `color` pays +1 mana at the start of its owner's turn. */
function payManaMages(state: GameState, color: Color): void {
  for (const e of state.effects) {
    if (e.kind !== 'manaMage' || e.owner !== color || !e.pieceId) continue;
    const sqIdx = state.board.findIndex((p) => p?.id === e.pieceId);
    if (sqIdx < 0) continue;
    const got = gainMana(state, color, 1, 'Mana mágus');
    addLog(state, color, 'mana', `Mana mágus (${squareName(sqIdx)}): ${got ? '+1 mana' : 'a mana tele, a bónusz elveszett'}.`);
  }
}

function continueAfterMove(state: GameState, pieceId: string): void {
  const c = state.turn;
  const ts = state.turnState;
  if (!ts.normalMoveDone) {
    ts.normalMoveDone = true;
    ts.firstMovePieceId = pieceId;
    const dm = colorEffect(state, c, 'doubleMove');
    if (dm) {
      removeEffect(state, dm.id);
      if (inCheck(state, opposite(c))) {
        addLog(state, c, 'system', 'Sakk! A Dupla lépés bónusza elveszett (sakkadás után nincs bónuszlépés).');
      } else {
        ts.bonusMoveAvailable = true;
        if (hasLegalMove(state)) {
          addLog(state, c, 'system', 'Dupla lépés: tehetsz még egy lépést egy másik bábuval (vagy fejezd be a kört).');
          evaluateStatus(state);
          return;
        }
        ts.bonusMoveAvailable = false;
      }
    }
  } else {
    ts.bonusMoveAvailable = false;
  }
  if (!state.options.autoEndTurn) {
    // Manual mode: spells may still be cast after the move; END_TURN finishes the turn.
    evaluateStatus(state);
    return;
  }
  endTurn(state);
}

function markMate(state: GameState, moveIdx: number): void {
  const rec = state.moveList[moveIdx];
  if (!rec) return;
  const base = rec.san.replace(/[+#]$/, '');
  if (state.status.kind === 'checkmate') rec.san = base + '#';
  else if (inCheck(state, state.turn) && state.turn !== rec.color) rec.san = base + '+';
}

/**
 * Legal moves per input state. `applyAction` never mutates its input and callers treat states as
 * immutable (the cast framework caches the same way), so trying many moves from one position – the
 * AI's search does exactly that – generates that position's moves only once.
 */
const legalCache = new WeakMap<GameState, Move[]>();
function cachedLegalMoves(state: GameState): Move[] {
  let legal = legalCache.get(state);
  if (!legal) legalCache.set(state, (legal = legalMoves(state)));
  return legal;
}

function doMove(state: GameState, from: number, to: number, promotion?: PromotionPiece): ActionResult {
  const legal = cachedLegalMoves(state);
  const cands = legal.filter((m) => m.from === from && m.to === to);
  const move: Move | undefined = cands.find((m) => m.castle) ?? cands[0];
  if (!move) return { ok: false, error: 'Szabálytalan lépés.' };
  if (move.promotion && promotion && isLostType(state, state.turn, promotion)) return { ok: false, error: lostError(promotion) };
  const san = moveToSan(state, move, legal);
  const draft = cloneState(state);
  const c = draft.turn;
  const isBonus = draft.turnState.normalMoveDone;
  draft.snapshots.push({
    board: cloneBoard(draft.board), ep: draft.ep ? { ...draft.ep } : null, halfmoveClock: draft.halfmoveClock,
    moveListLength: draft.moveList.length,
  });
  const piece = draft.board[move.from]!;
  const mage = isManaMage(draft, piece.id);
  const stepsOnMine = piece.type === 'K' && !move.defuse && draft.effects.some((e) => e.kind === 'mine' && e.squares?.includes(move.to));
  const res = applyMoveRaw(draft, move);
  if (stepsOnMine) {
    emit(draft, { type: 'defuse', square: move.to });
    addLog(draft, c, 'system', `${COLOR_NAME_HU[c]} királya rálépett az aknára és hatástalanította (${squareName(move.to)}).`);
  }
  if (move.ranged) emit(draft, { type: 'shot', from: move.from, to: res.capturedSquare ?? move.to, color: c });
  if (move.defuse) {
    emit(draft, { type: 'defuse', square: move.to });
    addLog(draft, c, 'system', `${COLOR_NAME_HU[c]} királya hatástalanította az aknát (${squareName(move.to)}).`);
  } else if (res.bounced) {
    emit(draft, { type: 'bounce', square: res.capturedSquare!, attackerSquare: move.from });
    addLog(draft, c, 'capture', `${squareName(move.from)} → ${squareName(move.to)}: a célpont megerősítése elnyelte ${move.ranged ? 'a lövést' : 'az ütést, a támadó visszapattant'}.`);
  } else if (!move.ranged) {
    emit(draft, { type: 'move', pieceId: piece.id, from: move.from, to: move.to });
    if (move.castle) {
      const r = move.from >> 3;
      const rFrom = r * 8 + (move.castle === 'K' ? 7 : 0);
      const rTo = r * 8 + (move.castle === 'K' ? 5 : 3);
      emit(draft, { type: 'move', pieceId: draft.board[rTo]!.id, from: rFrom, to: rTo });
    }
  }
  if (res.captured) {
    emit(draft, { type: 'capture', square: res.capturedSquare!, piece: { ...res.captured }, by: c });
    draft.players[c].captures++;
    draft.turnState.irreversible = true;
    const earns = captureEarnsMana(res.captured);
    const gained = earns ? gainMana(draft, c, MANA.PER_CAPTURE, 'capture') : 0;
    addLog(draft, c, 'capture', `${COLOR_NAME_HU[c]} ${move.ranged ? 'lelőtte' : 'leütötte'}: ${PIECE_NAME_HU[res.captured.type]} (${squareName(res.capturedSquare!)})${!earns ? ' (rabszolgáért nem jár mana)' : gained ? ' → +1 mana' : ' (mana tele)'}`);
    captureBonuses(draft, c, res.captured, mage);
  }
  if (res.cloneVanished) {
    emit(draft, { type: 'destroy', square: move.ranged ? move.from : move.to, piece: { ...piece } });
    addLog(draft, c, 'capture', `A klón (${PIECE_NAME_HU[piece.type]}) ütés után szertefoszlott.`);
  }
  reportShatter(draft, res, move.ranged ? move.from : move.to);
  if (piece.type === 'P' || piece.type === 'S') draft.turnState.irreversible = true;
  const idx = draft.moveList.length;
  const suffix =
    (move.ranged ? ' (lövés)' : '') + (res.bounced ? (move.ranged ? ' (elnyelve)' : ' (visszapattant)') : '') + (res.shattered ? ' (összetört)' : '');
  draft.moveList.push({ turnIndex: draft.turnIndex, color: c, san: san + suffix, kind: isBonus ? 'bonus' : 'move' });
  addLog(draft, c, 'move', `${COLOR_NAME_HU[c]}${isBonus ? ' (bónusz)' : ''}: ${san}${suffix}`);
  if (res.promotes && !res.bounced) {
    if (promotion) {
      piece.type = promotion;
      draft.moveList[idx].san += promotionSuffix(promotion);
      emit(draft, { type: 'promotion', square: move.to, piece: promotion });
    } else {
      draft.pendingPromotion = { square: move.to, pieceId: piece.id, color: c, context: 'move' };
      return commit(draft);
    }
  }
  continueAfterMove(draft, piece.id);
  markMate(draft, idx);
  return commit(draft);
}

/** „Végzet” erased this kind of piece: the pawn may not become one. */
const lostError = (t: PromotionPiece) => `A gyalog nem változhat ${INTO_HU[t]}: a Végzet kitörölte a létezésből.`;

function doPromote(state: GameState, pieceType: PromotionPiece): ActionResult {
  const pp = state.pendingPromotion;
  if (!pp) return { ok: false, error: 'Nincs függőben lévő átváltozás.' };
  if (!['Q', 'R', 'B', 'N'].includes(pieceType)) return { ok: false, error: 'Érvénytelen bábu.' };
  if (isLostType(state, pp.color, pieceType)) return { ok: false, error: lostError(pieceType) };
  const draft = cloneState(state);
  const p = draft.board[pp.square];
  if (!p || p.id !== pp.pieceId) return { ok: false, error: 'Az átváltozó gyalog nem található.' };
  p.type = pieceType;
  draft.pendingPromotion = null;
  emit(draft, { type: 'promotion', square: pp.square, piece: pieceType });
  addLog(draft, pp.color, 'move', `Gyalogátváltozás: ${PIECE_NAME_HU[pieceType]} (${squareName(pp.square)})`);
  if (pp.context === 'move') {
    const idx = draft.moveList.length - 1;
    if (idx >= 0) draft.moveList[idx].san += promotionSuffix(pieceType);
    continueAfterMove(draft, p.id);
    markMate(draft, idx);
  } else {
    evaluateStatus(draft);
  }
  return commit(draft);
}

function commit(draft: GameState): ActionResult {
  draft.eventSeq++;
  return { ok: true, state: draft };
}

/** The single entry point for changing the game. Never mutates `state`. */
export function applyAction(state: GameState, action: Action): ActionResult {
  if (state.status.kind !== 'playing') return { ok: false, error: 'A játszma véget ért.' };
  switch (action.type) {
    case 'MOVE':
      if (state.pendingPromotion) return { ok: false, error: 'Előbb válaszd ki, mivé változzon a gyalog.' };
      return doMove(state, action.from, action.to, action.promotion);
    case 'CAST': {
      const res = performCast(state, action.spellId, action.targets);
      if (typeof res === 'string') return { ok: false, error: res };
      evaluateStatus(res);
      return commit(res);
    }
    case 'PROMOTE':
      return doPromote(state, action.piece);
    case 'END_TURN': {
      const reason = endTurnBlockReason(state);
      if (reason) return { ok: false, error: reason };
      const draft = cloneState(state);
      if (draft.turnState.bonusMoveAvailable) addLog(draft, draft.turn, 'system', 'A bónuszlépés kimaradt.');
      else if (!draft.turnState.normalMoveDone) addLog(draft, draft.turn, 'system', `${COLOR_NAME_HU[draft.turn]} lépés nélkül fejezte be a körét.`);
      endTurn(draft);
      return commit(draft);
    }
    case 'RESIGN': {
      const draft = cloneState(state);
      finish(draft, { kind: 'resigned', winner: opposite(action.color) }, `${COLOR_NAME_HU[action.color]} feladta. ${COLOR_NAME_HU[opposite(action.color)]} nyert.`);
      return commit(draft);
    }
    case 'AGREE_DRAW': {
      const draft = cloneState(state);
      finish(draft, { kind: 'draw', reason: 'Megegyezés' }, 'Döntetlen megegyezéssel.');
      return commit(draft);
    }
    default:
      return { ok: false, error: 'Ismeretlen akció.' };
  }
}

/** Convenience for tests / scripts: apply or throw. */
export function mustApply(state: GameState, action: Action): GameState {
  const r = applyAction(state, action);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}
