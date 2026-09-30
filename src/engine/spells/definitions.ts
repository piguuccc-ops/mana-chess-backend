// ─────────────────────────────────────────────────────────────────────────────
// All spells (the original 50-spell design with the requested changes and additions). Each one is a
// self-contained object implementing `Spell`.
// Durations are expressed with the turn index T of the cast:
//   T     → until the end of this turn
//   T + 1 → until the end of the opponent's next turn (= start of your next turn)
//   T + 2 → until the end of your next turn
// ─────────────────────────────────────────────────────────────────────────────
import {
  chebyshev, fileOf, findKing, neighbours, onBoard, opposite, orthNeighbours, pawnDir, pawnStartRank, pawnSquareOk,
  promotionRank, rankOf, relRank, sq, squareName,
} from '../board';
import { COLOR_NAME_HU, PIECE_NAME_HU, PIECE_VALUE } from '../constants';
import { addEffect, buildCtx, colorHas, fx, globalHas, removePieceEffects } from '../effects';
import { INTO_HU, isLostType, promotionChoices } from '../erasure';
import { addLog, emit } from '../log';
import { clampMana, gainMana, loseMana } from '../mana';
import {
  ALL_DIRS, DIAG, KNIGHT_JUMPS, ORTH, applyMoveRaw, cloneForSim, inCheck, isSafe, knightTargets, legalMoves,
  pieceLegalMoves, pieceTargets, slideTargets,
} from '../movegen';
import { destroyByAttack, relocate, removeFromBoard, spellMove, swapSquares } from '../pieceOps';
import { randomInt } from '../rng';
import type { Board, Color, GameState, Piece, PromotionPiece, SpellId, Square } from '../types';
import {
  canRelocate, emptySquares, enemyPieces, hasEffect, isEmpty, isImmobile, mirrorSquare, movesWithEffect, ownPieces,
  pieceCount, rays, spellTargetable, squaresWhere, wallSquares,
} from './helpers';
import type { Spell, SpellContext } from './types';

const T = (c: SpellContext) => c.state.turnIndex;
const at = (c: SpellContext, s: Square): Piece => c.state.board[s]!;
const NON_KING = ['Q', 'R', 'B', 'N', 'P', 'S'] as const;

function pieceBuff(
  c: SpellContext, s: Square, kind: Parameters<typeof addEffect>[1]['kind'], expiresAfterTurn: number | null,
  source: Spell['id'], value?: number,
) {
  addEffect(c.state, {
    kind, owner: c.caster, source, pieceId: at(c, s).id, expiresAfterTurn, ...(value !== undefined ? { value } : {}),
  });
}

/** A pawn may be put on its last rank only while there is still something it can become („Végzet”). */
const pawnMayEnter = (state: GameState, color: Color, t: Square): boolean =>
  rankOf(t) !== promotionRank(color) || promotionChoices(state, color).length > 0;

/** Filters capture/non-capture destinations according to the piece's own debuffs. */
function respectDebuffs(state: GameState, p: Piece, targets: { to: Square; capture?: boolean }[]): Square[] {
  const ctx = buildCtx(state);
  const rooted = fx(ctx, p.id, 'rooted');
  const noCap = fx(ctx, p.id, 'blinded') || fx(ctx, p.id, 'disarmed');
  return targets.filter((t) => (!rooted || t.capture) && (!noCap || !t.capture)).map((t) => t.to);
}

// ── 1–6: movement buffs & free moves ────────────────────────────────────────

const pawnRush: Spell = {
  id: 'pawnRush', number: 1, name: 'Gyalogroham', manaCost: 2, category: 'Mozgás', icon: '🏃',
  description: 'Válassz egy saját gyalogot: ebben a körben a normál lépéseként két mezőt léphet előre akkor is, ha már mozgott – ha az út szabad.',
  targetType: 'ownPiece', steps: [{ prompt: 'Válassz egy saját gyalogot, amely két mezőt rohamozhat.' }],
  needsNormalMove: true,
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['P']).filter((s) => {
      const p = at(c, s);
      if (rankOf(s) === pawnStartRank(c.caster) || hasEffect(c.state, p, 'pawnRush')) return false;
      return movesWithEffect(c.state, s, {
        kind: 'pawnRush', owner: c.caster, source: 'pawnRush', pieceId: p.id, expiresAfterTurn: T(c),
      }).some((m) => m.doubleStep);
    }),
  execute: (c, [s]) => pieceBuff(c, s, 'pawnRush', T(c), 'pawnRush'),
  badge: 'Roham',
};

const knightLeap: Spell = {
  id: 'knightLeap', number: 2, name: 'Huszárugrás', manaCost: 2, category: 'Mozgás', icon: '🐎',
  description: 'Egy saját huszár azonnal végrehajt egy szabályos huszárlépést (üthet is). Ez nem számít a normál lépésednek.',
  targetType: 'pieceThenSquare',
  steps: [{ prompt: 'Válassz egy saját huszárt.' }, { prompt: 'Hová ugorjon a huszár?' }],
  getTargets: (c, picked) => {
    if (picked.length === 0) return ownPieces(c.state, c.caster, ['N']).filter((s) => !isImmobile(c.state, at(c, s)));
    return respectDebuffs(c.state, at(c, picked[0]), knightTargets(c.state, picked[0]));
  },
  execute: (c, [from, to]) => {
    spellMove(c.state, from, to);
  },
};

const bishopBlessing: Spell = {
  id: 'bishopBlessing', number: 3, name: 'Futóáldás', manaCost: 2, category: 'Mozgás', icon: '✨',
  description: 'Egy saját futó a következő saját köröd végéig egyszer átugorhat egy saját bábut (lépésnél és ütésnél is).',
  targetType: 'ownPiece', steps: [{ prompt: 'Válassz egy saját futót.' }],
  getTargets: (c) => ownPieces(c.state, c.caster, ['B']).filter((s) => !hasEffect(c.state, at(c, s), 'bishopBlessing')),
  execute: (c, [s]) => pieceBuff(c, s, 'bishopBlessing', T(c) + 2, 'bishopBlessing'),
  badge: 'Áldás',
};

const rookCharge: Spell = {
  id: 'rookCharge', number: 4, name: 'Bástyatöltés', manaCost: 2, category: 'Mozgás', icon: '🏰',
  description: 'Egy saját bástya azonnal legfeljebb 3 mezőt mozog vízszintesen vagy függőlegesen (üthet is). Nem számít a normál lépésednek.',
  targetType: 'pieceThenSquare',
  steps: [{ prompt: 'Válassz egy saját bástyát.' }, { prompt: 'Hová töltsön a bástya (max. 3 mező)?' }],
  getTargets: (c, picked) => {
    if (picked.length === 0) return ownPieces(c.state, c.caster, ['R']).filter((s) => !isImmobile(c.state, at(c, s)));
    return respectDebuffs(c.state, at(c, picked[0]), slideTargets(c.state, picked[0], ORTH, 3));
  },
  execute: (c, [from, to]) => {
    spellMove(c.state, from, to);
  },
};

const queenGrace: Spell = {
  id: 'queenGrace', number: 5, name: 'Vezér kegyelme', manaCost: 3, category: 'Mozgás', icon: '👑',
  description: 'A vezéred a következő saját köröd kezdetéig huszárként is léphet és üthet (+1 mozgásminta).',
  targetType: 'ownPiece', steps: [{ prompt: 'Válassz egy saját vezért.' }],
  getTargets: (c) => ownPieces(c.state, c.caster, ['Q']).filter((s) => !hasEffect(c.state, at(c, s), 'queenGrace')),
  execute: (c, [s]) => pieceBuff(c, s, 'queenGrace', T(c) + 1, 'queenGrace'),
  change: {
    original: 'A vezér a következő saját kör kezdetéig +1 mezőnyi maximális mozgástávolságot kap.',
    reason: 'A vezér 8×8-as táblán már most is bármilyen távolságra elér egy vonalban, így a „+1 mező” semmit sem változtatna. A +1 helyett +1 mozgásmintát kap (huszárlépés), a költség és az időtartam változatlan.',
  },
  badge: 'Kegyelem',
};

const kingStride: Spell = {
  id: 'kingStride', number: 6, name: 'Királylépés', manaCost: 1, category: 'Mozgás', icon: '👣',
  change: {
    original: 'Ebben a körben a király két mezőt léphet. (2 mana)',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 39%-át nyerte – a ritkán hasznos királylépés 2 manáért drága volt. Most 1 mana.',
    originalCost: 2,
  },
  description: 'Ebben a körben a király a normál lépésénél egy további mezőt léphet egyenes vonalban (összesen 2 mezőt). A köztes mező legyen üres és ne legyen támadott.',
  targetType: 'none', steps: [], needsNormalMove: true,
  canCast: (c) => {
    if (colorHas(c.state, c.caster, 'kingStride')) return false;
    const k = findKing(c.state.board, c.caster);
    if (k < 0) return false;
    return movesWithEffect(c.state, k, {
      kind: 'kingStride', owner: c.caster, source: 'kingStride', color: c.caster, expiresAfterTurn: T(c),
    }).some((m) => m.stride);
  },
  execute: (c) => {
    addEffect(c.state, { kind: 'kingStride', owner: c.caster, source: 'kingStride', color: c.caster, expiresAfterTurn: T(c) });
  },
};

// ── 7–10: protection & sacrifice ─────────────────────────────────────────────

const pawnShield: Spell = {
  id: 'pawnShield', number: 7, name: 'Gyalogpajzs', manaCost: 1, category: 'Védelem', icon: '🛡️',
  description: 'Egy saját gyalogot nem lehet leütni (lépéssel és spellel sem) az ellenfél következő körének végéig.',
  targetType: 'ownPiece', steps: [{ prompt: 'Válassz egy saját gyalogot.' }],
  getTargets: (c) => ownPieces(c.state, c.caster, ['P']).filter((s) => !hasEffect(c.state, at(c, s), 'immune')),
  execute: (c, [s]) => pieceBuff(c, s, 'immune', T(c) + 1, 'pawnShield'),
  badge: 'Pajzs',
};

const knightShield: Spell = {
  id: 'knightShield', number: 8, name: 'Huszárpajzs', manaCost: 2, category: 'Védelem', icon: '🔰',
  description: 'Egy saját huszárt nem lehet leütni (lépéssel és spellel sem) az ellenfél következő körének végéig.',
  targetType: 'ownPiece', steps: [{ prompt: 'Válassz egy saját huszárt.' }],
  getTargets: (c) => ownPieces(c.state, c.caster, ['N']).filter((s) => !hasEffect(c.state, at(c, s), 'immune')),
  execute: (c, [s]) => pieceBuff(c, s, 'immune', T(c) + 1, 'knightShield'),
  badge: 'Pajzs',
};

const fortify: Spell = {
  id: 'fortify', number: 9, name: 'Megerősítés', manaCost: 4, category: 'Védelem', icon: '💪',
  description: 'Egy saját (nem király) bábu túléli az első következő leütési kísérletet és a helyén marad; a támadó bábu visszapattan a kiinduló mezőjére, a lépése elvész. Addig marad érvényben, amíg el nem használódik.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bábut erősíted meg?' }],
  getTargets: (c) => ownPieces(c.state, c.caster, [...NON_KING]).filter((s) => !hasEffect(c.state, at(c, s), 'fortified')),
  execute: (c, [s]) => pieceBuff(c, s, 'fortified', null, 'fortify'),
  badge: 'Megerősítve',
  change: {
    original: 'Egy saját bábu túléli az első következő leütési kísérletet, és a helyén marad. (2 mana)',
    reason: 'Balansz-módosítás (kérésre): a korlátlan ideig tartó, bármelyik bábura – akár a vezérre – rakható védelem 2 manáért túl olcsó volt; most 4 mana.',
    originalCost: 2,
  },
};

const sacrifice: Spell = {
  id: 'sacrifice', number: 10, name: 'Áldozat', manaCost: 1, category: 'Mana', icon: '🕯️',
  change: {
    original: 'Egy saját gyalog megsemmisül, cserébe azonnal +1 manát kapsz.',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 42%-át nyerte – 1 manáért +1 mana nettó semmi volt, egy gyalogért. Most +3 mana (nettó +2).',
  },
  description: 'Egy saját gyalog megsemmisül, cserébe azonnal +3 manát kapsz (vonalnyitásra, ciklusgyorsításra és egy nagy spell előrehozására jó).',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik gyalogot áldozod fel?' }],
  getTargets: (c) => ownPieces(c.state, c.caster, ['P']),
  execute: (c, [s]) => {
    removeFromBoard(c.state, s);
    gainMana(c.state, c.caster, 3, 'Áldozat');
  },
};

// ── 11–20: tactical relocation ──────────────────────────────────────────────

const forcedMarch: Spell = {
  id: 'forcedMarch', number: 11, name: 'Erőltetett menet', manaCost: 2, category: 'Mozgás', icon: '🥾',
  description: 'Egy saját gyalog egy mezőt előrelép (nem üt) anélkül, hogy a normál lépésedet felhasználnád.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik gyalog meneteljen?' }],
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['P']).filter((s) => {
      const r = rankOf(s) + pawnDir(c.caster);
      return r >= 0 && r <= 7 && canRelocate(c.state, at(c, s)) && isEmpty(c.state, sq(fileOf(s), r)) && pawnMayEnter(c.state, c.caster, sq(fileOf(s), r));
    }),
  execute: (c, [s]) => {
    relocate(c.state, s, s + 8 * pawnDir(c.caster));
  },
};

/** Squares on the piece's movement pattern, ignoring blockers (for „Teleport”). */
function teleportSquares(state: GameState, s: Square): Square[] {
  const p = state.board[s]!;
  let cand: Square[] = [];
  switch (p.type) {
    case 'P': {
      const r1 = rankOf(s) + pawnDir(p.color);
      if (r1 >= 0 && r1 <= 7 && pawnMayEnter(state, p.color, sq(fileOf(s), r1))) cand.push(sq(fileOf(s), r1));
      if (rankOf(s) === pawnStartRank(p.color)) cand.push(sq(fileOf(s), rankOf(s) + 2 * pawnDir(p.color)));
      break;
    }
    case 'N':
      for (const [df, dr] of KNIGHT_JUMPS) {
        const f = fileOf(s) + df;
        const r = rankOf(s) + dr;
        if (f >= 0 && f < 8 && r >= 0 && r < 8) cand.push(sq(f, r));
      }
      break;
    case 'B':
      cand = rays(s, DIAG);
      break;
    case 'R':
      cand = rays(s, ORTH);
      break;
    case 'Q':
      cand = rays(s, ALL_DIRS);
      break;
    case 'K':
      cand = neighbours(s);
      break;
    case 'S': {
      const r1 = rankOf(s) + pawnDir(p.color);
      if (r1 >= 0 && r1 <= 7) cand.push(sq(fileOf(s), r1));
      break;
    }
  }
  const walls = wallSquares(state);
  return cand.filter((t) => !state.board[t] && !walls.has(t));
}

const teleport: Spell = {
  id: 'teleport', number: 12, name: 'Teleport', manaCost: 5, category: 'Mozgás', icon: '🌀',
  description: 'Egy saját bábut áthelyezel egy üres mezőre, ahová a saját mozgásmintájával egy lépésben eljuthatna – a köztes bábuk nem akadályozzák (teleportál). Nem üt, és nem számít normál lépésnek.',
  targetType: 'pieceThenSquare',
  steps: [{ prompt: 'Melyik bábut teleportálod?' }, { prompt: 'Válaszd ki a célmezőt.' }],
  getTargets: (c, picked) => {
    if (picked.length === 0)
      return ownPieces(c.state, c.caster).filter((s) => canRelocate(c.state, at(c, s)) && teleportSquares(c.state, s).length > 0);
    return teleportSquares(c.state, picked[0]);
  },
  execute: (c, [from, to]) => {
    relocate(c.state, from, to);
  },
  change: {
    original: 'Egy saját bábut áthelyezhetsz bármely üres mezőre, amelyre az adott bábu normál esetben egyetlen lépéssel eljuthatna.',
    reason: 'Szó szerint értelmezve ez egy sima, ütés nélküli lépés lett volna (a 2 manás Huszárugrásnál is gyengébb). A „teleport” jelleg miatt a köztes bábukat figyelmen kívül hagyja. Ára kérésre 4-ről 5 manára emelkedett.',
    originalCost: 4,
  },
};

const swap: Spell = {
  id: 'swap', number: 13, name: 'Csere', manaCost: 3, category: 'Taktika', icon: '🔄',
  description: 'Felcseréled két saját, különböző típusú, nem király bábu helyét. Gyalog nem kerülhet az 1. vagy 8. sorra.',
  targetType: 'twoOwnPieces',
  steps: [{ prompt: 'Válaszd ki az első bábut.' }, { prompt: 'Válaszd ki a második bábut.' }],
  getTargets: (c, picked) => {
    const movable = ownPieces(c.state, c.caster, [...NON_KING]).filter((s) => canRelocate(c.state, at(c, s)));
    if (picked.length === 0) return movable;
    const a = picked[0];
    const pa = at(c, a);
    return movable.filter((b) => {
      const pb = at(c, b);
      if (b === a || pb.type === pa.type) return false;
      if (pa.type === 'P' && !pawnSquareOk(c.caster, b)) return false;
      if (pb.type === 'P' && !pawnSquareOk(c.caster, a)) return false;
      return true;
    });
  },
  execute: (c, [a, b]) => swapSquares(c.state, a, b),
};

const emergencySwap: Spell = {
  id: 'emergencySwap', number: 14, name: 'Vészcsere', manaCost: 4, category: 'Védelem', icon: '🚨',
  description: 'A királyod helyet cserél egy saját bástyáddal, ha a csere után a király nincs sakkban. (A sáncolási jog elvész.)',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bástyával cseréljen a király?' }],
  requireKingSafe: true,
  getTargets: (c) => ownPieces(c.state, c.caster, ['R']).filter((s) => canRelocate(c.state, at(c, s))),
  execute: (c, [r]) => swapSquares(c.state, findKing(c.state.board, c.caster), r),
};

const stepBack: Spell = {
  id: 'stepBack', number: 15, name: 'Visszalépés', manaCost: 3, category: 'Idő', icon: '↩️',
  description: 'Egy saját bábu visszaáll arra a mezőre, ahol a legutóbbi mozgása előtt állt (ha az most üres). Nem számít normál lépésnek.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bábu lépjen vissza?' }],
  getTargets: (c) =>
    ownPieces(c.state, c.caster).filter((s) => {
      const p = at(c, s);
      if (p.prevSquare === null || p.prevSquare === s || !canRelocate(c.state, p)) return false;
      if (p.type === 'P' && !pawnSquareOk(c.caster, p.prevSquare)) return false;
      return isEmpty(c.state, p.prevSquare);
    }),
  execute: (c, [s]) => {
    relocate(c.state, s, at(c, s).prevSquare!);
  },
};

const doubleMove: Spell = {
  id: 'doubleMove', number: 16, name: 'Dupla lépés', manaCost: 4, category: 'Mozgás', icon: '⏩',
  description: 'A normál lépésed után egy MÁSIK saját bábuval még egy szabályos lépést tehetsz. Ha az első lépés sakkot ad, a bónuszlépés elvész.',
  targetType: 'none', steps: [], beforeMoveOnly: true,
  canCast: (c) => !colorHas(c.state, c.caster, 'doubleMove'),
  execute: (c) => {
    addEffect(c.state, { kind: 'doubleMove', owner: c.caster, source: 'doubleMove', color: c.caster, expiresAfterTurn: T(c) });
  },
  change: {
    original: 'A normál sakk-lépésed után egy másik saját bábuval is végrehajthatsz egy szabályos lépést.',
    reason: 'Két egymást követő lépés sakkadással kombinálva védhetetlen matthoz vezethetne (az ellenfél nem reagálhat a sakkra). A marseille-i sakk szabálya szerint: ha az első lépés sakkot ad, a bónuszlépés elvész. A spellt a normál lépés előtt kell kijátszani (a normál lépés automatikusan befejezi a kört).',
  },
};

const instantPromotion: Spell = {
  id: 'instantPromotion', number: 17, name: 'Azonnali átváltozás', manaCost: 5, category: 'Taktika', icon: '🌟',
  description: 'Egy saját gyalog, amely már a 6. vagy 7. soron áll (a saját szemszögedből), azonnal átváltozik vezérré, bástyává, futóvá vagy huszárrá – helyben.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik gyalog változzon át?' }],
  getTargets: (c) =>
    promotionChoices(c.state, c.caster).length ? ownPieces(c.state, c.caster, ['P']).filter((s) => relRank(c.caster, s) >= 5) : [],
  execute: (c, [s]) => {
    c.state.pendingPromotion = { square: s, pieceId: at(c, s).id, color: c.caster, context: 'spell' };
  },
  change: {
    original: 'Egy utolsó sorra érkezett gyalog azonnal átváltoztatható.',
    reason: 'Az utolsó sorra érkező gyalog a sakkszabályok szerint amúgy is azonnal átváltozik, így a spellnek nem lenne hatása. Most a már „utolsó sorokba” (6–7. sor) ért gyalogot változtatja át helyben.',
  },
};

const royalGuard: Spell = {
  id: 'royalGuard', number: 18, name: 'Királyvédelem', manaCost: 3, category: 'Védelem', icon: '⚜️',
  description: 'Az ellenfél következő körében nem adhat sakkot a királyodnak – sem lépéssel, sem spellel. A király továbbra sem léphet sakkba.',
  targetType: 'none', steps: [],
  canCast: (c) => !colorHas(c.state, c.caster, 'royalGuard'),
  execute: (c) => {
    addEffect(c.state, { kind: 'royalGuard', owner: c.caster, source: 'royalGuard', color: c.caster, expiresAfterTurn: T(c) + 1 });
  },
  change: {
    original: 'A királyod a következő ellenfélkörben védett a leütéstől, de továbbra sem állhat szabályosan sakkban.',
    reason: 'A sakkban a királyt soha nem lehet leütni, így a „leütés elleni védelem” hatástalan lenne. A legközelebbi értelmes változat: a védett királyt a következő ellenfélkörben nem lehet sakkba hozni.',
  },
};

const checkBreaker: Spell = {
  id: 'checkBreaker', number: 19, name: 'Sakkmegszakító', manaCost: 2, category: 'Védelem', icon: '💨',
  description: 'Csak sakkban: a királyod azonnal átugrik egy szomszédos, üres, nem támadott mezőre. Nem számít normál lépésnek.',
  targetType: 'emptySquare', steps: [{ prompt: 'Hová meneküljön a király?' }],
  requireKingSafe: true,
  canCast: (c) => inCheck(c.state, c.caster),
  getTargets: (c) => {
    const k = findKing(c.state.board, c.caster);
    return k < 0 ? [] : neighbours(k).filter((s) => isEmpty(c.state, s));
  },
  execute: (c, [to]) => {
    relocate(c.state, findKing(c.state.board, c.caster), to);
  },
};

const recastle: Spell = {
  id: 'recastle', number: 20, name: 'Újrasáncolás', manaCost: 1, category: 'Taktika', icon: '🏯',
  change: {
    original: 'Újra engedélyezi a sáncolást. (3 mana)',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 39%-át nyerte, a lap ritkán kijátszható és kis hatású. Most 1 mana, így legalább olcsón továbbforgatható.',
    originalCost: 3,
  },
  description: 'Ha a király és egy bástya a kiinduló mezőjén áll, újra engedélyezi a sáncolást – akkor is, ha a jog korábban (lépés vagy spell miatt) elveszett.',
  targetType: 'none', steps: [],
  canCast: (c) => recastleRooks(c.state, c.caster).length > 0,
  execute: (c) => {
    const br = c.caster === 'w' ? 0 : 7;
    const king = c.state.board[sq(4, br)]!;
    king.hasMoved = false;
    for (const r of recastleRooks(c.state, c.caster)) c.state.board[r]!.hasMoved = false;
  },
};

function recastleRooks(state: GameState, c: Color): Square[] {
  const br = c === 'w' ? 0 : 7;
  const king = state.board[sq(4, br)];
  if (!king || king.type !== 'K' || king.color !== c) return [];
  return [sq(0, br), sq(7, br)].filter((s) => {
    const r = state.board[s];
    return r && r.type === 'R' && r.color === c && (r.hasMoved || king.hasMoved);
  });
}

// ── 21–30: control / debuffs ────────────────────────────────────────────────

function enemyDebuff(
  id: Spell['id'], number: number, name: string, cost: number, icon: string, kind: Parameters<typeof addEffect>[1]['kind'],
  description: string, badge: string, types: Piece['type'][] = [...NON_KING], extra?: Partial<Spell>,
): Spell {
  return {
    id, number, name, manaCost: cost, category: 'Irányítás', icon, description, badge,
    targetType: 'enemyPiece', steps: [{ prompt: `${name}: válassz egy ellenséges bábut.` }],
    getTargets: (c) => enemyPieces(c.state, c.caster, types).filter((s) => !hasEffect(c.state, at(c, s), kind)),
    execute: (c, [s]) => pieceBuff(c, s, kind, T(c) + 1, id),
    ...extra,
  };
}

const deathMark: Spell = {
  id: 'deathMark', number: 21, name: 'Halálbélyeg', manaCost: 2, category: 'Pusztítás', icon: '💀',
  description: 'Megjelölsz egy ellenséges bábut (a következő saját köröd végéig). A következő szabályos támadásod ellene garantáltan leüti: figyelmen kívül hagyja a pajzsokat és a megerősítést.',
  targetType: 'enemyPiece', steps: [{ prompt: 'Kit bélyegzel meg?' }],
  getTargets: (c) =>
    enemyPieces(c.state, c.caster, [...NON_KING]).filter(
      (s) => !c.state.effects.some((e) => e.kind === 'deathMark' && e.pieceId === at(c, s).id && e.owner === c.caster),
    ),
  execute: (c, [s]) => pieceBuff(c, s, 'deathMark', T(c) + 2, 'deathMark'),
  badge: 'Bélyeg',
};

const weaken = enemyDebuff('weaken', 22, 'Gyengítés', 3, '🥀', 'weakened',
  'Egy ellenséges (nem király) bábu a következő körében egyáltalán nem mozoghat (és nem üthet).', 'Gyenge', undefined, {
    change: {
      original: 'Egy ellenséges (nem király) bábu a következő körében egyáltalán nem mozoghat (és nem üthet). (2 mana)',
      reason: 'Balansz-módosítás (kérésre): egy bábu – akár a vezér – teljes megbénítása 2 manáért túl olcsó volt (a Gyökér és a Vakfolt ennyiért csak félig köt meg); most 3 mana.',
      originalCost: 2,
    },
  });

const root = enemyDebuff('root', 24, 'Gyökér', 2, '🌿', 'rooted',
  'Egy ellenséges (nem király) bábu a következő körében nem léphet üres mezőre, de ütni továbbra is tud.', 'Gyökér');

const blindSpot = enemyDebuff('blindSpot', 25, 'Vakfolt', 2, '🙈', 'blinded',
  'Egy ellenséges (nem király) bábu a következő körében nem üthet le egyetlen bábudat sem (de továbbra is sakkot adhat és mezőket tarthat).', 'Vak');

const silence: Spell = {
  id: 'silence', number: 26, name: 'Némaság', manaCost: 2, category: 'Irányítás', icon: '🤐',
  description: 'Az ellenfél a következő körében nem használhat spellt.',
  targetType: 'none', steps: [],
  change: {
    original: 'Az ellenfél a következő körében nem használhat spellt. (1 mana)',
    reason: 'Balansz-módosítás (kérésre): egy teljes kör spell-tiltás 1 manáért túl olcsó volt; most 2 mana.',
    originalCost: 1,
  },
  canCast: (c) => !colorHas(c.state, c.opp, 'silenced'),
  execute: (c) => {
    addEffect(c.state, { kind: 'silenced', owner: c.caster, source: 'silence', color: c.opp, expiresAfterTurn: T(c) + 1 });
  },
};

const manaDrain: Spell = {
  id: 'manaDrain', number: 27, name: 'Manaelszívás', manaCost: 3, category: 'Mana', icon: '🧛',
  description: 'Az ellenfél legfeljebb 2 manát veszít.',
  targetType: 'none', steps: [],
  canCast: (c) => c.state.players[c.opp].mana > 0,
  execute: (c) => {
    loseMana(c.state, c.opp, 2, 'Manaelszívás');
  },
};

const disarm = enemyDebuff('disarm', 29, 'Hatástalanítás', 2, '🚫', 'disarmed',
  'Egy ellenséges (nem király) bábu a következő saját köre végéig nem üthet, és a támadásai sem számítanak: nem ad sakkot, a királyod mellé/elé léphet.', 'Lefegyverezve',
  undefined, {
    change: {
      original: 'Egy ellenfél-bábu a következő saját köréig nem üthet.',
      reason: 'Szó szerint azonos lett volna a Vakfolttal (25). A megkülönböztetés: a Vakfolt csak az ütést tiltja, a Hatástalanítás a bábu fenyegetését (sakkadás, mezőtartás) is kikapcsolja. Ára kérésre 3-ról 2 manára csökkent.',
      originalCost: 3,
    },
  });

const pawnFreeze = enemyDebuff('pawnFreeze', 30, 'Gyalogfagyasztás', 1, '❄️', 'frozen',
  'Egy ellenséges gyalog a következő körében nem mozoghat (és nem üthet).', 'Fagyott', ['P']);

// ── 31–40: terrain, chaos and time ──────────────────────────────────────────

const wall: Spell = {
  id: 'wall', number: 31, name: 'Fal', manaCost: 1, category: 'Terep', icon: '🧱',
  change: {
    original: 'Egy üres mezőre falat emelsz az ellenfél következő körének végéig. (2 mana)',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 40%-át nyerte – egy körig álló, a saját bábuidat is akadályozó fal 2 manáért drága volt. Most 1 mana.',
    originalCost: 2,
  },
  description: 'Egy üres mezőre falat emelsz az ellenfél következő körének végéig: sem bábu nem léphet rá, sem nem haladhat át rajta (a huszár átugorhatja, de nem érkezhet rá).',
  targetType: 'emptySquare', steps: [{ prompt: 'Hová emeled a falat?' }],
  getTargets: (c) => emptySquares(c.state),
  execute: (c, [s]) => {
    addEffect(c.state, { kind: 'wall', owner: c.caster, source: 'wall', squares: [s], expiresAfterTurn: T(c) + 1 });
  },
};

const barricade: Spell = {
  id: 'barricade', number: 32, name: 'Barikád', manaCost: 3, category: 'Terep', icon: '🚧',
  description: 'Két egymás melletti (vízszintesen vagy függőlegesen szomszédos) üres mezőt blokkolsz az ellenfél következő körének végéig.',
  targetType: 'twoSquares', steps: [{ prompt: 'Válaszd ki az első mezőt.' }, { prompt: 'Válassz egy szomszédos üres mezőt.' }],
  getTargets: (c, picked) => {
    const empty = new Set(emptySquares(c.state));
    if (picked.length === 0) return [...empty].filter((s) => orthNeighbours(s).some((n) => empty.has(n)));
    return orthNeighbours(picked[0]).filter((n) => empty.has(n));
  },
  execute: (c, [a, b]) => {
    addEffect(c.state, { kind: 'wall', owner: c.caster, source: 'barricade', squares: [a, b], expiresAfterTurn: T(c) + 1 });
  },
};

const gravity: Spell = {
  id: 'gravity', number: 34, name: 'Gravitáció', manaCost: 2, category: 'Terep', icon: '🧲',
  change: {
    original: 'Az ellenfél következő körének végéig egyik huszár sem ugorhat át bábukat. (3 mana)',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 38%-át nyerte – a mindkét félre ható, rövid huszárzár 3 manáért drága volt. Most 2 mana.',
    originalCost: 3,
  },
  description: 'Az ellenfél következő körének végéig egyik huszár sem ugorhat át bábukat: a huszár csak akkor léphet, ha a hosszabbik irányban mellette lévő mező üres (mint a kínai sakk lova).',
  targetType: 'none', steps: [],
  canCast: (c) => !globalHas(c.state, 'gravity') && squaresWhere(c.state, (p) => p.type === 'N').length > 0,
  execute: (c) => {
    addEffect(c.state, { kind: 'gravity', owner: c.caster, source: 'gravity', expiresAfterTurn: T(c) + 1 });
  },
};

/** All swaps „Káosz” may choose from (never unsafe for the caster). */
export function chaosCandidates(state: GameState, caster: Color): [Square, Square][] {
  const pieces = squaresWhere(state, (p) => p.type !== 'K');
  const safeBefore = isSafe(state, caster);
  const opp = opposite(caster);
  const guard = colorHas(state, opp, 'royalGuard');
  const oppCheckBefore = guard ? inCheck(state, opp) : false;
  const out: [Square, Square][] = [];
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i];
      const b = pieces[j];
      const pa = state.board[a]!;
      const pb = state.board[b]!;
      if (pa.type === pb.type && pa.color === pb.color) continue;
      if (pa.type === 'P' && !pawnSquareOk(pa.color, b)) continue;
      if (pb.type === 'P' && !pawnSquareOk(pb.color, a)) continue;
      const sim = cloneForSim(state);
      const tmp: Board = sim.board;
      tmp[a] = pb;
      tmp[b] = pa;
      if (safeBefore && !isSafe(sim, caster)) continue;
      if (guard && !oppCheckBefore && inCheck(sim, opp)) continue;
      out.push([a, b]);
    }
  return out;
}

const chaos: Spell = {
  id: 'chaos', number: 35, name: 'Káosz', manaCost: 4, category: 'Taktika', icon: '🎲',
  description: 'Két véletlenszerű, nem király bábu (bármelyik színből) helyet cserél. A csere sosem hozhatja a királyodat sakkba, és gyalog nem kerülhet az 1./8. sorra.',
  targetType: 'none', steps: [], random: true,
  canCast: (c) => chaosCandidates(c.state, c.caster).length > 0,
  execute: (c) => {
    const cands = chaosCandidates(c.state, c.caster);
    const [a, b] = cands[randomInt(c.state, cands.length)];
    const pa = c.state.board[a]!;
    const pb = c.state.board[b]!;
    swapSquares(c.state, a, b);
    addLog(c.state, c.caster, 'spell', `Káosz: ${PIECE_NAME_HU[pa.type]} ↔ ${PIECE_NAME_HU[pb.type]}`);
    emit(c.state, { type: 'spell', spellId: 'chaos', color: c.caster, squares: [a, b] });
  },
};

const mirror: Spell = {
  id: 'mirror', number: 36, name: 'Tükör', manaCost: 3, category: 'Mozgás', icon: '🪞',
  description: 'Egy saját (nem király) bábu átkerül a tükörképmezőjére (a tábla függőleges középvonalára tükrözve, pl. c3 → f3), ha az üres. Az eredeti helyéről eltűnik – nem jön létre másolat.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bábut tükrözöd?' }],
  getTargets: (c) =>
    ownPieces(c.state, c.caster, [...NON_KING]).filter((s) => canRelocate(c.state, at(c, s)) && isEmpty(c.state, mirrorSquare(s))),
  execute: (c, [s]) => {
    relocate(c.state, s, mirrorSquare(s));
  },
  change: {
    original: 'Egy saját bábu átkerülhet egy üres mezőre, az eredeti bábu pedig eltűnik. Ez ne hozzon létre másolatot.',
    reason: 'A tábla bármely üres mezőjére való áthelyezés 3 manáért erősebb lett volna a 4 manás Teleportnál. A „Tükör” név alapján a bábu a tükörképmezőjére kerül.',
  },
};

const timeStop: Spell = {
  id: 'timeStop', number: 37, name: 'Időmegállítás', manaCost: 5, category: 'Idő', icon: '⏸️',
  description: 'Az ellenfél a következő körében nem tehet normál sakk-lépést, legfeljebb egy spellt használhat. Kivétel: ha a királya sakkban van, léphet, hogy elhárítsa.',
  targetType: 'none', steps: [],
  canCast: (c) => !colorHas(c.state, c.opp, 'timeStop'),
  execute: (c) => {
    addEffect(c.state, { kind: 'timeStop', owner: c.caster, source: 'timeStop', color: c.opp, expiresAfterTurn: T(c) + 1 });
  },
  change: {
    original: 'Az ellenfél a következő körében nem tehet normál sakk-lépést, de egy spellt használhat.',
    reason: 'Kiegészítés a király biztonsága érdekében: ha az időmegállítás után sakkot adsz, az ellenfél léphet a sakk elhárítására, különben a spell automatikus mattot jelentene.',
  },
};

const rewind: Spell = {
  id: 'rewind', number: 38, name: 'Visszatekerés', manaCost: 5, category: 'Idő', icon: '⏪',
  description: 'A teljes sakkállás visszaáll az utolsó normál sakk-lépés előtti állapotra (a leütött bábuk visszatérnek). A mana, a spell-ciklus és az aktív hatások változatlanok. A normál lépésed előtt használható.',
  targetType: 'none', steps: [], beforeMoveOnly: true,
  canCast: (c) => c.state.snapshots.length > 0,
  execute: (c) => {
    const st = c.state;
    const snap = st.snapshots[st.snapshots.length - 1];
    st.snapshots = st.snapshots.slice(0, -1);
    // „Végzet”: an erased piece is gone from history too – the rewound position lacks it
    const erased = new Set(st.erased.map((p) => p.id));
    const restored: Board = snap.board.map((p) => (p && !erased.has(p.id) ? { ...p } : null));
    const restoredIds = new Set(restored.filter(Boolean).map((p) => p!.id));
    const currentPos = new Map<string, Square>();
    st.board.forEach((p, s) => p && currentPos.set(p.id, s));
    for (const col of ['w', 'b'] as Color[]) st.captured[col] = st.captured[col].filter((p) => !restoredIds.has(p.id));
    st.board.forEach((p) => {
      if (p && !restoredIds.has(p.id)) st.captured[p.color].push({ ...p });
    });
    st.board = restored;
    st.ep = null;
    st.halfmoveClock = snap.halfmoveClock;
    st.moveList = st.moveList.map((m, i) => (i >= snap.moveListLength ? { ...m, rewound: true } : m));
    st.effects = st.effects.filter((e) => !e.pieceId || restoredIds.has(e.pieceId));
    restored.forEach((p, s) => {
      if (!p) return;
      const from = currentPos.get(p.id);
      if (from !== undefined && from !== s) emit(st, { type: 'move', pieceId: p.id, from, to: s });
    });
  },
};

/** Pawns that „Földrengés” moves (simultaneously, based on the current board). */
export function earthquakeMoves(state: GameState): [Square, Square][] {
  const walls = wallSquares(state);
  const ctx = buildCtx(state);
  const moves: [Square, Square][] = [];
  for (let s = 0; s < 64; s++) {
    const p = state.board[s];
    if (!p || p.type !== 'P') continue;
    if (fx(ctx, p.id, 'weakened') || fx(ctx, p.id, 'frozen') || fx(ctx, p.id, 'rooted')) continue;
    const r = rankOf(s) + pawnDir(p.color);
    if (r < 0 || r > 7 || r === promotionRank(p.color)) continue;
    const t = sq(fileOf(s), r);
    if (state.board[t] || walls.has(t)) continue;
    moves.push([s, t]);
  }
  const counts = new Map<Square, number>();
  moves.forEach(([, t]) => counts.set(t, (counts.get(t) ?? 0) + 1));
  return moves.filter(([, t]) => counts.get(t) === 1);
}

const earthquake: Spell = {
  id: 'earthquake', number: 39, name: 'Földrengés', manaCost: 3, category: 'Terep', icon: '🌋',
  description: 'Minden gyalog (mindkét színből) egyszerre egy mezőt előrelép a saját menetirányában, ha előtte üres a mező. Átváltozó sorra nem lép, és ha két gyalog ugyanarra a mezőre lépne, egyik sem mozdul.',
  targetType: 'none', steps: [],
  canCast: (c) => earthquakeMoves(c.state).length > 0,
  execute: (c) => {
    const moves = earthquakeMoves(c.state);
    const pieces = moves.map(([f]) => c.state.board[f]!);
    moves.forEach(([f]) => (c.state.board[f] = null));
    moves.forEach(([f, t], i) => {
      const p = pieces[i];
      c.state.board[t] = p;
      p.prevSquare = f;
      p.hasMoved = true;
      emit(c.state, { type: 'move', pieceId: p.id, from: f, to: t });
    });
    c.state.turnState.irreversible = true;
  },
  change: {
    original: 'Minden gyalog egy mezővel közelebb kerül az aktuális menetirányának megfelelően, ha az adott mozgás szabályosan végrehajtható.',
    reason: 'Pontosítás a stabilitás érdekében: a lépések egyszerre történnek, az átváltozó sorra nem lép gyalog (egyszerre több átváltozás elkerülése), ütközés esetén egyik gyalog sem mozdul, és ha az eredmény a királyodat sakkba hozná, a spell nem használható. Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 42%-át nyerte – a mindkét félnek segítő gyalogroham 4 manáért drága volt; most 3 mana.',
    originalCost: 4,
  },
};

const dimensionShift: Spell = {
  id: 'dimensionShift', number: 40, name: 'Dimenzióváltás', manaCost: 5, category: 'Terep', icon: '🌌',
  description: 'Kijelölsz egy 3×3-as területet: az ellenfél következő körének végéig az ott álló összes nem király bábu (mindkét színből) kizárólag huszárként léphet és üthet.',
  targetType: 'zone', steps: [{ prompt: 'Válaszd ki a 3×3-as terület közepét.' }],
  getTargets: () => {
    const out: Square[] = [];
    for (let r = 1; r <= 6; r++) for (let f = 1; f <= 6; f++) out.push(sq(f, r));
    return out;
  },
  execute: (c, [center]) => {
    addEffect(c.state, {
      kind: 'dimensionZone', owner: c.caster, source: 'dimensionShift', squares: [center, ...neighbours(center)],
      expiresAfterTurn: T(c) + 1,
    });
  },
  change: {
    original: 'Egy kiválasztott 3×3-as területen a bábuk mozgása egy körig megváltozik a spell által meghatározott módon.',
    reason: 'Az eredeti leírás nem határozta meg a változást. Meghatározott szabály: a zónában álló nem király bábuk huszárként mozognak.',
  },
};

// ── 41–46: mana economy ─────────────────────────────────────────────────────

const bloodPrice: Spell = {
  id: 'bloodPrice', number: 41, name: 'Vérár', manaCost: 2, category: 'Mana', icon: '🩸',
  description: 'Feláldozol egy saját (nem király) bábut, és azonnal 3 manát kapsz.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bábut áldozod fel?' }],
  getTargets: (c) => ownPieces(c.state, c.caster, [...NON_KING]),
  execute: (c, [s]) => {
    removeFromBoard(c.state, s);
    gainMana(c.state, c.caster, 3, 'Vérár');
  },
};

const overcharge: Spell = {
  id: 'overcharge', number: 42, name: 'Túltöltés', manaCost: 2, category: 'Mana', icon: '🔋',
  description: 'A következő spelled 2 manával olcsóbb (minimum 1 mana). A kedvezmény megmarad, amíg fel nem használod.',
  targetType: 'none', steps: [],
  canCast: (c) => !colorHas(c.state, c.caster, 'discount'),
  execute: (c) => {
    addEffect(c.state, { kind: 'discount', owner: c.caster, source: 'overcharge', color: c.caster, expiresAfterTurn: null, value: 2 });
  },
  change: {
    original: 'A következő spellt 2 manával olcsóbban használhatod, minimum 1 mana költséggel. (3 mana)',
    reason: '3 manáért 2 mana megtakarítás mindig veszteséges lett volna. 2 manás költséggel semleges „mana-akkumulátor”: segít a 6-os plafon feletti manát átmenteni.',
    originalCost: 3,
  },
};

const arcaneSurge: Spell = {
  id: 'arcaneSurge', number: 43, name: 'Arcane Surge', manaCost: 1, category: 'Mana', icon: '⚡',
  description: 'Azonnal kapsz 3 manát, de a következő saját köröd végéig a maximális manád 4.',
  targetType: 'none', steps: [],
  canCast: (c) => !colorHas(c.state, c.caster, 'manaCap') && c.state.players[c.caster].mana - 1 < 4,
  execute: (c) => {
    addEffect(c.state, { kind: 'manaCap', owner: c.caster, source: 'arcaneSurge', color: c.caster, expiresAfterTurn: T(c) + 2, value: 4 });
    gainMana(c.state, c.caster, 3, 'Arcane Surge');
    clampMana(c.state, c.caster);
  },
  change: {
    original: 'Azonnal kapsz 3 manát, de a következő saját köröd végéig a maximális manád 4. (4 mana)',
    reason: '4 manáért 3 manát adott volna vissza (és még plafont is szabott), vagyis mindig veszteséges volt. 1 manás költséggel „vészhelyzeti töltés”: +2 nettó mana, cserébe két körig max. 4.',
    originalCost: 4,
  },
};

const gambit: Spell = {
  id: 'gambit', number: 44, name: 'Gambit', manaCost: 1, category: 'Mana', icon: '🃏',
  description: 'Az ellenfél kap 2 manát, te pedig azonnal eggyel előrébb lépsz a spell-ciklusban (a kezed első lapja a pakli végére kerül, új lapot húzol).',
  targetType: 'none', steps: [],
  execute: (c) => {
    gainMana(c.state, c.opp, 2, 'Gambit');
    const pl = c.state.players[c.caster];
    if (pl.deck.length > 1) {
      const first = pl.deck.shift()!;
      pl.deck.push(first);
      pl.cycleCount++;
      emit(c.state, { type: 'cycle', color: c.caster, used: first, drawn: pl.deck[2] ?? null });
    }
  },
};

const lastChance: Spell = {
  id: 'lastChance', number: 46, name: 'Utolsó esély', manaCost: 3, category: 'Védelem', icon: '🕊️',
  change: {
    original: 'Csak ha kevesebb bábud van: minden saját bábud túléli a következő leütési kísérletet. (5 mana)',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 38%-át nyerte, és a lapot szinte sosem lehetett jól kijátszani – csak hátrányban használható, egy körig véd, mégis a korlátozott 5 manás helyet foglalta. Most 3 mana.',
    originalCost: 5,
  },
  description: 'Csak ha kevesebb bábud van, mint az ellenfélnek: minden saját bábud túléli a következő leütési kísérletet az ellenfél következő körének végéig.',
  targetType: 'none', steps: [],
  canCast: (c) => pieceCount(c.state, c.caster) < pieceCount(c.state, c.opp),
  execute: (c) => {
    for (const s of ownPieces(c.state, c.caster, [...NON_KING])) pieceBuff(c, s, 'fortified', T(c) + 1, 'lastChance');
  },
};

// ── 47–50: ultimates ────────────────────────────────────────────────────────

const execution: Spell = {
  id: 'execution', number: 47, name: 'Kivégzés', manaCost: 5, category: 'Pusztítás', icon: '⚔️',
  description: 'Azonnal leütsz egy legfeljebb 3 pont értékű ellenséges bábut (gyalog, rabszolga, huszár, futó), bárhol is áll. Királyt nem célozhat; a pajzs véd, a megerősítés elnyeli (kivéve Halálbélyeg esetén).',
  targetType: 'enemyPiece', steps: [{ prompt: 'Kit végzel ki?' }],
  change: {
    original: 'Azonnal leüthetsz egy legfeljebb 3 pont értékű ellenfél-bábut, függetlenül a távolságtól. (6 mana)',
    reason: 'Balansz-módosítás (kérésre): 6 manáért egyetlen könnyűtiszt elvesztése kevés volt; most 5 mana.',
    originalCost: 6,
  },
  getTargets: (c) =>
    enemyPieces(c.state, c.caster, ['P', 'S', 'N', 'B']).filter(
      (s) => PIECE_VALUE[at(c, s).type] <= 3 && spellTargetable(c.state, at(c, s), c.caster),
    ),
  execute: (c, [s]) => {
    destroyByAttack(c.state, s, c.caster);
  },
};

/** „Meteor”: maximum material (in points) one impact may destroy. */
export const METEOR_BUDGET = 4;

const meteor: Spell = {
  id: 'meteor', number: 48, name: 'Meteor', manaCost: 6, category: 'Pusztítás', icon: '☄️',
  description: `Elpusztítasz egy legfeljebb ${METEOR_BUDGET} pontos bábut (gyalog, rabszolga, huszár, futó – bástyát, vezért nem) és a vele szomszédos gyalogokat/rabszolgákat (bármelyik színből) – összesen legfeljebb ${METEOR_BUDGET} pontnyi anyagot (gyalog/rabszolga 1, huszár/futó 3). A becsapódás után először az ellenséges, aztán a saját szomszédokat éri. A pajzs véd, a megerősítés elnyeli.`,
  targetType: 'anyPiece', steps: [{ prompt: 'Hová csapódjon a meteor?' }],
  change: {
    original: 'Pusztíts el egy nem király bábut, valamint minden vele szomszédos gyalogot.',
    reason: `Balansz-módosítás (kérésre): egy találattal akár vezér + 8 gyalog is eltűnhetett, ezért lett egy 9 pontos korlát. ${'Egyensúly-teszt (1000 AI-játszma, véletlen paklik)'}: a Meteoros pakli így is a játszmák 85%-át nyerte (a 6 manás lapok mind kiugróan erősek voltak), 5 pontos korláttal (vezér nélkül) még mindig 74%-ot. Most ${METEOR_BUDGET} pont: bástyára és vezérre nem lehet lőni.`,
  },
  getTargets: (c) =>
    squaresWhere(c.state, (p) => p.type !== 'K' && PIECE_VALUE[p.type] <= METEOR_BUDGET && spellTargetable(c.state, p, c.caster)),
  execute: (c, [s]) => {
    let budget = METEOR_BUDGET;
    const main = c.state.board[s]!;
    if (destroyByAttack(c.state, s, c.caster) === 'destroyed') budget -= PIECE_VALUE[main.type];
    // Splash: enemy pawns first, then the caster's own – as long as the material budget allows.
    const splash = neighbours(s)
      .filter((n) => {
        const p = c.state.board[n];
        return p && (p.type === 'P' || p.type === 'S');
      })
      .sort((a, b) => Number(c.state.board[a]!.color === c.caster) - Number(c.state.board[b]!.color === c.caster) || a - b);
    for (const n of splash) {
      const v = PIECE_VALUE[c.state.board[n]!.type];
      if (v > budget) continue;
      if (destroyByAttack(c.state, n, c.caster) === 'destroyed') budget -= v;
    }
  },
};

const necromancy: Spell = {
  id: 'necromancy', number: 49, name: 'Nekromancia', manaCost: 2, category: 'Taktika', icon: '🧟',
  description: 'Egy korábban levett saját gyalogod visszatér a kezdősorodra egy általad választott üres mezőre.',
  targetType: 'emptySquare', steps: [{ prompt: 'Hová támadjon fel a gyalog?' }],
  canCast: (c) => c.state.captured[c.caster].some((p) => p.type === 'P' && !p.clone),
  getTargets: (c) => emptySquares(c.state).filter((s) => rankOf(s) === pawnStartRank(c.caster)),
  execute: (c, [s]) => {
    const list = c.state.captured[c.caster];
    const idx = list.map((p) => (p.type === 'P' && !p.clone ? 'P' : '-')).lastIndexOf('P');
    list.splice(idx, 1);
    const pawn: Piece = { id: `p${c.state.nextId++}`, type: 'P', color: c.caster, hasMoved: false, prevSquare: null };
    c.state.board[s] = pawn;
    c.state.turnState.irreversible = true;
  },
  change: {
    original: 'Egy korábban levett saját gyalogod visszatér a kezdősorodra egy általad választott üres mezőre. (5 mana)',
    reason: 'Balansz-módosítás (kérésre): egyetlen gyalog visszahozása a kezdősorra 5 manáért túl drága volt; most 2 mana.',
    originalCost: 5,
  },
};

const realityBreak: Spell = {
  id: 'realityBreak', number: 50, name: 'Valóságtörés', manaCost: 6, category: 'Taktika', icon: '🔮',
  description: 'Ebben a körben a nem király bábuid átsiklanak a köztes SAJÁT bábuidon (az ellenségeseken nem) – a gyalog kettőslépése is. A király nem léphet sakkba, királyt ütni nem lehet, a falak továbbra is akadályoznak.',
  targetType: 'none', steps: [], needsNormalMove: true,
  canCast: (c) => !colorHas(c.state, c.caster, 'realityBreak'),
  execute: (c) => {
    addEffect(c.state, { kind: 'realityBreak', owner: c.caster, source: 'realityBreak', color: c.caster, expiresAfterTurn: T(c) });
  },
  change: {
    original: 'Egy teljes körig a normál bábumozgási szabályok jelentős része figyelmen kívül hagyható. A király továbbra sem léphet sakkba, és király nem üthető le.',
    reason: 'Konkretizálva: a saját köröd idejére a bábuid átsiklanak a köztes bábukon és +1 királylépést kapnak. Csak a te köröd, hogy ne segítse az ellenfelet is. Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 78%-át nyerte, főleg mert a bábuk az ellenséges bábukon át is ütöttek (a gyalogfal mögött álló bástyát, vezért). Most csak a saját bábuikon siklanak át – és mivel így is 66%-ot ért el, a „+1 mező bármely irányba” kiegészítés is kimaradt.',
  },
};

// ── Additions ───────────────────────────────────────────────────────────────

/** Own ranks 1–3 (relative), i.e. every rank before the 4th. */
const summonZone = (c: SpellContext) => emptySquares(c.state).filter((s) => relRank(c.caster, s) <= 2);

export const BRIGADE_SIZE = 5;

const brigade: Spell = {
  id: 'brigade', number: 51, name: 'Brigád', manaCost: 3, category: 'Taktika', icon: '👥',
  change: {
    original: 'Ugyanez 5 manáért.',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a Brigádos pakli csak a játszmák 28%-át nyerte – 5 manáért 5 ütni nem tudó bábu kevés volt, és minden leütött rabszolga +1 manát adott az ellenfélnek. Most 3 mana, és a rabszolga leütéséért nem jár mana.',
    originalCost: 5,
  },
  description: `Leidézel ${BRIGADE_SIZE} rabszolgát a saját 1–3. sorodba, az általad választott üres mezőkre. A rabszolga gyalogszerű bábu: mindig csak egy mezőt léphet előre (kezdő kettőslépés sincs), nem üthet, ezért nem támad és sakkot sem ad, és nem változik át. Leütni lehet (1 pont), de mana nem jár érte.`,
  targetType: 'multiSquare',
  steps: Array.from({ length: BRIGADE_SIZE }, (_, i) => ({
    prompt: `${i + 1}/${BRIGADE_SIZE}. rabszolga: válassz egy üres mezőt a saját 1–3. sorodban.`,
  })),
  fastTargets: true,
  getTargets: (c, picked) => summonZone(c).filter((s) => !picked.includes(s)),
  execute: (c, targets) => {
    for (const s of targets) {
      c.state.board[s] = { id: `p${c.state.nextId++}`, type: 'S', color: c.caster, hasMoved: false, prevSquare: null };
    }
    c.state.turnState.irreversible = true;
  },
  added: {
    reason: 'Új spell (kérésre), a kivett Tűzés helyére: 5 lassú, ütni nem tudó gyalogszerű bábu – élő fal, blokkolás és tempónyerés.',
  },
};

/** „Klón” price: half the piece's value + 1, rounded up (pawn/servant 2, knight/bishop 3, rook 4, queen 6). */
export const cloneCost = (type: Piece['type']): number => Math.ceil(PIECE_VALUE[type] / 2 + 2);

/** „Körforgás”: has the caster's card charged up – will this cast be the awakened one? */
function charged(c: SpellContext, id: SpellId, need: number): boolean {
  return (c.state.players[c.caster].charges[id] ?? 0) >= need;
}

/** „Klón”: does `color` have a clone on the board? */
const livingClone = (state: GameState, color: Color): boolean => state.board.some((p) => !!p?.clone && p.color === color);

/** „Mana mágus”: does `color` have a living mage? */
function livingMage(state: GameState, color: Color): boolean {
  return state.effects.some((e) => e.kind === 'manaMage' && e.owner === color && !!e.pieceId && state.board.some((p) => p?.id === e.pieceId));
}

/** Adjacent empty squares where a clone of the piece on `from` may appear (no pawn on rank 1/8, never giving check). */
function cloneSquares(state: GameState, from: Square): Square[] {
  const orig = state.board[from];
  if (!orig || orig.type === 'K') return [];
  const oppKing = findKing(state.board, opposite(orig.color));
  return neighbours(from).filter((t) => {
    if (!isEmpty(state, t)) return false;
    if (orig.type === 'P' && !pawnSquareOk(orig.color, t)) return false;
    const sim = cloneForSim(state);
    sim.board[t] = { ...orig, id: 'clone-preview', clone: true };
    return !pieceTargets(sim, buildCtx(sim), t, 'attacks').some((a) => a.to === oppKing);
  });
}

const clone: Spell = {
  id: 'clone', number: 52, name: 'Klón', manaCost: 3, costLabel: '3–5', category: 'Taktika', icon: '🧬',
  change: {
    original: 'Ára a bábu értékének fele + 1 (gyalog/rabszolga 2, huszár/futó 3, bástya 4, vezér 6).',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a Klónos pakli a játszmák 66%-át nyerte. Minden klón 1 manával drágább (2–6 helyett 3–5 mana), vezért nem lehet klónozni, és (mivel így is 62% lett) egyszerre csak egy klónod lehet.',
  },
  description: 'Leklónozod egy saját (nem király, nem vezér) bábudat, és a klónt lerakod a bábu melletti (1 mezőnyire lévő) bármelyik szabad mezőre – kivéve, ha onnan sakkot adna. A klón félig átlátszó, ugyanúgy mozog, mint az eredeti, de amint leüt valamit, szertefoszlik. Egyszerre csak egy klónod lehet. Ára: a bábu értékének fele + 2, felfelé kerekítve (gyalog/rabszolga 3, huszár/futó 4, bástya 5).',
  targetType: 'pieceThenSquare',
  steps: [{ prompt: 'Melyik bábudat klónozod?' }, { prompt: 'Hová kerüljön a klón (szomszédos szabad mező)?' }],
  costFor: (c, [from]) => {
    const p = c.state.board[from];
    return p ? cloneCost(p.type) : 99;
  },
  canCast: (c) => !livingClone(c.state, c.caster),
  getTargets: (c, picked) => {
    if (picked.length === 0) {
      // „Végzet”: a kind of piece that was erased may not be made again – not even as a clone
      return ownPieces(c.state, c.caster, ['P', 'S', 'N', 'B', 'R']).filter(
        (s) => !isLostType(c.state, c.caster, at(c, s).type) && cloneSquares(c.state, s).length > 0,
      );
    }
    return cloneSquares(c.state, picked[0]);
  },
  execute: (c, [from, to]) => {
    const orig = at(c, from);
    c.state.board[to] = { id: `p${c.state.nextId++}`, type: orig.type, color: c.caster, hasMoved: true, prevSquare: null, clone: true };
    if (orig.type === 'P' || orig.type === 'S') c.state.turnState.irreversible = true;
  },
  added: {
    reason: 'Új spell (kérésre): változó ár (a bábu értékétől függ), egyszer használható „kamikaze” másolat.',
  },
};

/** Moves of the piece on `s` that only exist because of the previewed effect. */
function newMovesWithEffect(state: GameState, s: Square, eff: Parameters<typeof movesWithEffect>[2]) {
  const before = legalMoves(state).filter((m) => m.from === s);
  const key = (m: { to: Square; captureSquare?: Square; ranged?: boolean }) => `${m.to}:${m.captureSquare ?? ''}:${m.ranged ? 1 : 0}`;
  const known = new Set(before.map(key));
  return movesWithEffect(state, s, eff).filter((m) => !known.has(key(m)));
}

const frenchCheese: Spell = {
  id: 'frenchCheese', number: 53, name: 'Francia sajt', manaCost: 3, category: 'Taktika', icon: '🧀',
  change: {
    original: 'Ugyanez 2 manáért.',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 65%-át nyerte – 2 manáért egy gyalog bármilyen mellette álló bábut, akár vezért üthetett. Most 3 mana, és (mivel így is 63%-ot ért el) vezért nem üthet.',
    originalCost: 2,
  },
  description: 'Válassz egy saját gyalogot: ebben a körben a normál lépéseként en passant üthet BÁRMILYEN mellette (ugyanabban a sorban, közvetlenül balra/jobbra) álló ellenséges bábut: átlósan előre lép az üres mezőre a bábu mögé, a mellette álló bábu pedig megsemmisül. Királyt és vezért nem üthet, a pajzs véd, a megerősítés elnyeli.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik gyalogod üssön francia módra (en passant)?' }],
  needsNormalMove: true,
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['P']).filter((s) => {
      const p = at(c, s);
      if (hasEffect(c.state, p, 'frenchCheese')) return false;
      return newMovesWithEffect(c.state, s, {
        kind: 'frenchCheese', owner: c.caster, source: 'frenchCheese', pieceId: p.id, expiresAfterTurn: T(c),
      }).some((m) => m.enPassant);
    }),
  execute: (c, [s]) => pieceBuff(c, s, 'frenchCheese', T(c), 'frenchCheese'),
  badge: 'Francia sajt',
  added: {
    reason: 'Új spell (kérésre): az en passant szabály kiterjesztése bármilyen szomszédos ellenséges bábura, egy körre.',
  },
};

const bishopSniper: Spell = {
  id: 'bishopSniper', number: 54, name: 'Futólövész', manaCost: 4, category: 'Pusztítás', icon: '🎯',
  description: 'Válassz egy saját futót: ebben a körben a normál lépéseként lelőhetsz vele egy ellenséges bábut, amelyet a szabályos mozgása alapján amúgy is leüthetne – a futó viszont nem mozdul el a helyéről, a célpont megsemmisül. A lövés ütésnek számít (+1 mana), a pajzs véd, a megerősítés elnyeli.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik futód lőjön?' }],
  needsNormalMove: true,
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['B']).filter((s) => {
      const p = at(c, s);
      if (hasEffect(c.state, p, 'sniper')) return false;
      return movesWithEffect(c.state, s, {
        kind: 'sniper', owner: c.caster, source: 'bishopSniper', pieceId: p.id, expiresAfterTurn: T(c),
      }).some((m) => m.ranged);
    }),
  execute: (c, [s]) => pieceBuff(c, s, 'sniper', T(c), 'bishopSniper'),
  badge: 'Lövész',
  added: {
    reason: 'Új spell (kérésre): távolsági ütés – a futó a helyén marad, így nem kerül veszélybe és nem nyit vonalat.',
  },
};

/** „Mana mágus”: number of the caster's own turns that pay the +1 income. */
export const MANA_MAGE_TURNS = 3;

const manaMage: Spell = {
  id: 'manaMage', number: 55, name: 'Mana mágus', manaCost: 2, category: 'Mana', icon: '🧙',
  change: {
    original: 'Egyszerre több mana mágus is dolgozhatott. (3 mana)',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 63%-át nyerte – az újra és újra kijátszott, egymás mellett dolgozó mágusok túl sok manát termeltek. Egyszerre csak egy mágus dolgozik: az új a régi helyére lép (a lap így mindig kijátszható, nem ragad be a kézbe). Halmozás nélkül 3 manáért már veszteséges volt (37–44%), ezért 2 mana.',
    originalCost: 3,
  },
  description: `Egy legfeljebb 3 pont értékű saját bábudat (gyalog, rabszolga, huszár, futó) mana mágussá teszed a következő ${MANA_MAGE_TURNS} saját körödre. Amíg él: minden körödben +1 extra manát kapsz (összesen +2/kör), és ha üt vele, +1 extra manát kapsz a szokásos +1 mellé. Aki spellel öli meg, azonnal 1 manát veszít. Egyszerre csak egy mana mágusod dolgozik: ha újat teszel, a régi elveszíti az erejét.`,
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bábudból legyen mana mágus (max. 3 pont)?' }],
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['P', 'S', 'N', 'B']).filter(
      (s) => PIECE_VALUE[at(c, s).type] <= 3 && !hasEffect(c.state, at(c, s), 'manaMage'),
    ),
  execute: (c, [s]) => {
    // one mage at a time: the new one takes over from the old
    if (livingMage(c.state, c.caster)) addLog(c.state, c.caster, 'mana', 'Az előző mana mágus elveszítette az erejét – az új veszi át a helyét.');
    c.state.effects = c.state.effects.filter((e) => !(e.kind === 'manaMage' && e.owner === c.caster));
    pieceBuff(c, s, 'manaMage', T(c) + 2 * MANA_MAGE_TURNS, 'manaMage');
  },
  badge: 'Mana mágus',
  added: {
    reason: 'Új spell (kérésre): befektetés – legfeljebb +3 mana a következő 3 körben (+ütésenként +1); aki spellel öli meg, 1 manával fizet érte.',
  },
};


// ── Additions, 3rd batch: Akna, El az útból! and the balanced picks from the 50 proposals ──

/** Squares where a mine may be hidden: no wall, no king, no mine yet. */
function mineSquares(state: GameState): Square[] {
  const ctx = buildCtx(state);
  const out: Square[] = [];
  for (let s = 0; s < 64; s++) {
    if (ctx.walls.has(s) || ctx.mines.has(s) || state.board[s]?.type === 'K') continue;
    out.push(s);
  }
  return out;
}

const mine: Spell = {
  id: 'mine', number: 56, name: 'Akna', manaCost: 4, category: 'Terep', icon: '💣',
  description: 'Aknát rejtesz a tábla egy mezőjére (üres mezőre vagy egy bábu alá – a királyok mezője kivétel). Az ellenfél következő körének végén felrobban, és elpusztítja az éppen rajta álló nem király bábut, bármelyik színű is. A pajzs vagy a megerősítés megvédi a bábut, de a robbanásban megsemmisül. A mellette (1 mezőre) álló király a lépéseként hatástalaníthatja – helyben maradva, vagy rálépve. Az akna mindkét játékos számára látható.',
  targetType: 'anySquare', steps: [{ prompt: 'Hová rejted az aknát?' }],
  getTargets: (c) => mineSquares(c.state),
  execute: (c, [s]) => {
    addEffect(c.state, { kind: 'mine', owner: c.caster, source: 'mine', squares: [s], expiresAfterTurn: T(c) + 1 });
  },
  added: {
    reason: 'Új spell (kérésre). Pontosítva: az akna látható (helyi játékban úgysem lehetne titkos), a hatástalanítás a király normál lépése, és ha a király rálép, az is hatástalanítja.',
  },
};

function asideSquares(state: GameState, from: Square): Square[] {
  const p = state.board[from];
  if (!p) return [];
  return neighbours(from).filter((t) => isEmpty(state, t) && (p.type !== 'P' || pawnSquareOk(p.color, t)));
}

const outOfWay: Spell = {
  id: 'outOfWay', number: 57, name: 'El az útból!', manaCost: 2, category: 'Mozgás', icon: '👋',
  description: 'Egy saját (nem király) bábudat félreállítod egy szomszédos üres mezőre – ez nem számít normál lépésnek. Ebben a körben semmi nem léphet a bábu eredeti mezőjére (áthaladni rajta szabad), a félreállított bábu nem léphet tovább, és a köröd végén automatikusan visszatér a helyére.',
  targetType: 'pieceThenSquare',
  steps: [{ prompt: 'Melyik bábudat állítod félre?' }, { prompt: 'Hová álljon félre (szomszédos üres mező)?' }],
  getTargets: (c, picked) => {
    if (picked.length === 0) {
      return ownPieces(c.state, c.caster, [...NON_KING]).filter((s) => canRelocate(c.state, at(c, s)) && asideSquares(c.state, s).length > 0);
    }
    return asideSquares(c.state, picked[0]);
  },
  execute: (c, [from, to]) => {
    const p = at(c, from);
    const restore = { hasMoved: p.hasMoved, prevSquare: p.prevSquare };
    relocate(c.state, from, to);
    addEffect(c.state, {
      kind: 'outOfWay', owner: c.caster, source: 'outOfWay', pieceId: p.id, squares: [from], expiresAfterTurn: T(c), restore,
    });
  },
  badge: 'Félreállt',
  added: {
    reason: 'Új spell (kérésre). Kiegészítve: a félreállított bábu ebben a körben nem léphet tovább (különben „kiütni és hazafutni” trükkre lehetne használni), és a király nem állítható félre.',
  },
};

/** Castling moves that are legal right now (as a spell they ignore the turn phase). */
function castleMoves(state: GameState, c: Color) {
  const k = findKing(state.board, c);
  if (k < 0) return [];
  return pieceLegalMoves(state, k).filter((m) => m.castle);
}

const quickCastle: Spell = {
  id: 'quickCastle', number: 58, name: 'Gyorssánc', manaCost: 2, category: 'Mozgás', icon: '🏁',
  description: 'Azonnal elvégzed a sáncolást spellként – ez nem számít a normál lépésednek. A szokásos feltételek érvényesek: a király és a bástya még nem lépett, az út üres, a király nincs sakkban, és nem halad át / nem érkezik támadott mezőre.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bástyával sáncolsz?' }],
  getTargets: (c) => {
    const br = rankOf(findKing(c.state.board, c.caster));
    return castleMoves(c.state, c.caster).map((m) => sq(m.castle === 'K' ? 7 : 0, br));
  },
  execute: (c, [rookSq]) => {
    const side = fileOf(rookSq) === 7 ? 'K' : 'Q';
    const m = castleMoves(c.state, c.caster).find((x) => x.castle === side)!;
    const king = at(c, m.from);
    const rook = at(c, rookSq);
    applyMoveRaw(c.state, m);
    const br = rankOf(m.from);
    emit(c.state, { type: 'move', pieceId: king.id, from: m.from, to: m.to });
    emit(c.state, { type: 'move', pieceId: rook.id, from: rookSq, to: sq(side === 'K' ? 5 : 3, br) });
    addLog(c.state, c.caster, 'move', `Gyorssánc: ${side === 'K' ? 'O-O' : 'O-O-O'}`);
  },
  added: {
    reason: 'Új spell (javaslatból). Balansz: 1 → 2 mana – egy teljes plusz lépés, mint a Huszárugrás.',
    proposal: 'Ha a király és a bástya között szabad az út, azonnal elvégezheted a sáncolást spellként (nem számít normál lépésnek).',
    proposalCost: 1,
  },
};

const pawnVault: Spell = {
  id: 'pawnVault', number: 59, name: 'Gyalogugrás', manaCost: 2, category: 'Mozgás', icon: '🦘',
  description: 'Válassz egy saját gyalogot: ebben a körben a normál lépéseként átugorhatja a közvetlenül előtte álló bábut (bármelyik színűt) a mögötte lévő üres mezőre. Nem üt, falat nem ugorhat át; ha az átváltozó sorra érkezik, átváltozik.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik gyalogod ugorjon?' }],
  needsNormalMove: true,
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['P']).filter((s) => {
      const p = at(c, s);
      if (hasEffect(c.state, p, 'pawnVault')) return false;
      return newMovesWithEffect(c.state, s, {
        kind: 'pawnVault', owner: c.caster, source: 'pawnVault', pieceId: p.id, expiresAfterTurn: T(c),
      }).length > 0;
    }),
  execute: (c, [s]) => pieceBuff(c, s, 'pawnVault', T(c), 'pawnVault'),
  badge: 'Ugrás',
  added: {
    reason: 'Új spell (javaslatból). Balansz: 1 → 2 mana – egy blokkolt gyalog így szabad gyaloggá válhat; a Gyalogroham is 2 mana. A normál lépésedet használja.',
    proposal: 'Egy saját gyalogod átugorhat egy közvetlenül előtte álló bábut egy üres mezőre (nem üt).',
    proposalCost: 1,
  },
};

const provoke: Spell = {
  id: 'provoke', number: 60, name: 'Provokáció', manaCost: 3, category: 'Irányítás', icon: '📣',
  change: {
    original: 'Ugyanez 2 manáért.',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a pakli a játszmák 58–67%-át nyerte (két futásban), az AI játszmánként 3–4-szer kényszerített vele. Most 3 mana.',
    originalCost: 2,
  },
  description: 'Kijelölsz egy ellenséges gyalogot vagy rabszolgát: az ellenfél következő körében a normál lépését ezzel a bábuval kell megtennie, ha az tud szabályosan lépni (spelleket ettől még használhat).',
  targetType: 'enemyPiece', steps: [{ prompt: 'Melyik ellenséges gyalogot provokálod?' }],
  getTargets: (c) => enemyPieces(c.state, c.caster, ['P', 'S']).filter((s) => !hasEffect(c.state, at(c, s), 'provoked')),
  execute: (c, [s]) => pieceBuff(c, s, 'provoked', T(c) + 1, 'provoke'),
  badge: 'Provokálva',
  added: {
    reason: 'Új spell (javaslatból). Balansz: 1 → 2 mana – egy kényszerlépés akár egy fontos gyalogláncot is szétszedhet.',
    proposal: 'Kijelölsz egy ellenséges gyalogot: a következő körben kötelező lépnie, ha tud.',
    proposalCost: 1,
  },
};

const invisibility: Spell = {
  id: 'invisibility', number: 61, name: 'Láthatatlanság', manaCost: 2, category: 'Védelem', icon: '👻',
  description: 'Egy saját (nem király) bábudat az ellenfél következő körének végéig nem célozhatják az ellenfél spelljei. A területre ható, nem célzott spellek (pl. a Meteor szórása, Földrengés, Végítélet) továbbra is érik, a Pajzsromboló pedig eltávolítja.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik bábudat rejted el a spellek elől?' }],
  getTargets: (c) => ownPieces(c.state, c.caster, [...NON_KING]).filter((s) => !hasEffect(c.state, at(c, s), 'spellWard')),
  execute: (c, [s]) => pieceBuff(c, s, 'spellWard', T(c) + 1, 'invisibility'),
  badge: 'Láthatatlan',
  added: { reason: 'Új spell (javaslatból): célzott spellek elleni védelem – ütés ellen nem véd, a pajzsokkal ellentétben.' },
};

// Straight lines (rows, files, diagonals) between two squares.
function lineStep(a: Square, b: Square): [number, number] | null {
  const df = fileOf(b) - fileOf(a);
  const dr = rankOf(b) - rankOf(a);
  if (a === b || (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr))) return null;
  return [Math.sign(df), Math.sign(dr)];
}

function clearBetween(state: GameState, a: Square, b: Square): boolean {
  const step = lineStep(a, b);
  if (!step) return false;
  const walls = buildCtx(state).walls;
  let f = fileOf(a) + step[0];
  let r = rankOf(a) + step[1];
  while (sq(f, r) !== b) {
    if (state.board[sq(f, r)] || walls.has(sq(f, r))) return false;
    f += step[0];
    r += step[1];
  }
  return true;
}

/** Destination of an enemy piece on `e` moved one square along `step`, if allowed. */
function nudgeTarget(state: GameState, e: Square, step: [number, number]): Square | null {
  const f = fileOf(e) + step[0];
  const r = rankOf(e) + step[1];
  if (!onBoard(f, r)) return null;
  const t = sq(f, r);
  const p = state.board[e]!;
  if (!isEmpty(state, t) || (p.type === 'P' && !pawnSquareOk(p.color, t))) return null;
  return t;
}

const movableEnemy = (c: SpellContext) => enemyPieces(c.state, c.caster, [...NON_KING]);

/** „Mágnes”: own pieces in a clear line with the enemy piece that can pull it one square closer. */
function magnetSources(c: SpellContext, e: Square): Square[] {
  return ownPieces(c.state, c.caster).filter((o) => {
    const step = lineStep(e, o);
    return !!step && chebyshev(e, o) >= 2 && clearBetween(c.state, e, o) && nudgeTarget(c.state, e, step) !== null;
  });
}

/** „Taszítás”: own pieces in a clear line with the enemy piece that can push it one square away. */
function repulseSources(c: SpellContext, e: Square): Square[] {
  return ownPieces(c.state, c.caster).filter((o) => {
    const step = lineStep(o, e);
    return !!step && clearBetween(c.state, o, e) && nudgeTarget(c.state, e, step) !== null;
  });
}

const magnet: Spell = {
  id: 'magnet', number: 62, name: 'Mágnes', manaCost: 3, category: 'Taktika', icon: '🪝',
  description: 'Válassz egy ellenséges (nem király) bábut, majd egy vele egy vonalban (sor, oszlop vagy átló) álló saját bábudat, ha köztük üres az út: az ellenséges bábu egy mezőt közelebb csúszik hozzá. Gyalog nem kerülhet az 1./8. sorra.',
  targetType: 'twoSquares',
  steps: [{ prompt: 'Melyik ellenséges bábut húzod?' }, { prompt: 'Melyik saját bábud felé húzod?' }],
  getTargets: (c, picked) => {
    if (picked.length === 0) return movableEnemy(c).filter((e) => magnetSources(c, e).length > 0);
    return magnetSources(c, picked[0]);
  },
  execute: (c, [e, o]) => {
    relocate(c.state, e, nudgeTarget(c.state, e, lineStep(e, o)!)!);
  },
  added: {
    reason: 'Új spell (javaslatból). Pontosítva: te választod ki, melyik (vele egy vonalban álló, szabad rálátású) bábud felé húzod. Balansz: 2 → 3 mana, mert egy bábut egy lépéssel ütésbe húzni akár vezért is nyerhet.',
    proposal: 'Egy ellenséges bábut 1 mezővel közelebb húzol a legközelebbi saját bábudhoz (ha üres a mező).',
    proposalCost: 2,
  },
};

const repulse: Spell = {
  id: 'repulse', number: 63, name: 'Taszítás', manaCost: 3, category: 'Taktika', icon: '🌬️',
  description: 'Válassz egy ellenséges (nem király) bábut, majd egy vele egy vonalban (sor, oszlop vagy átló) álló saját bábudat, ha köztük üres az út: az ellenséges bábu egy mezőt hátrébb csúszik tőle ugyanabban az irányban, ha ott üres a mező. Gyalog nem kerülhet az 1./8. sorra.',
  targetType: 'twoSquares',
  steps: [{ prompt: 'Melyik ellenséges bábut taszítod el?' }, { prompt: 'Melyik saját bábudtól taszítod el?' }],
  getTargets: (c, picked) => {
    if (picked.length === 0) return movableEnemy(c).filter((e) => repulseSources(c, e).length > 0);
    return repulseSources(c, picked[0]);
  },
  execute: (c, [e, o]) => {
    relocate(c.state, e, nudgeTarget(c.state, e, lineStep(o, e)!)!);
  },
  added: {
    reason: 'Új spell (javaslatból), a Mágnes párja. Balansz: 2 → 3 mana (ugyanazért, mint a Mágnes).',
    proposal: 'Egy ellenséges bábut 1 mezővel eltolsz a saját bábudtól egyenes vonalban.',
    proposalCost: 2,
  },
};

export const MANA_DEPOSIT_RETURN = 3;

const manaDeposit: Spell = {
  id: 'manaDeposit', number: 64, name: 'Mana-letét', manaCost: 2, category: 'Mana', icon: '🏦',
  description: `Most 2 manát fizetsz, a következő saját köröd elején pedig +${MANA_DEPOSIT_RETURN} manát kapsz vissza (a szokásos +1 mellé; a maximum feletti rész elvész).`,
  targetType: 'none', steps: [],
  execute: (c) => {
    addEffect(c.state, {
      kind: 'manaDeposit', owner: c.caster, source: 'manaDeposit', color: c.caster, value: MANA_DEPOSIT_RETURN, expiresAfterTurn: T(c) + 2,
    });
  },
  added: { reason: 'Új spell (javaslatból): kis befektetés (+1 mana egy kör késéssel) és olcsó ciklusgyorsítás.' },
};

const scout: Spell = {
  id: 'scout', number: 65, name: 'Cserkész', manaCost: 1, category: 'Mozgás', icon: '🧭',
  description: 'Válassz egy saját gyalogot: ebben a körben a normál lépéseként oldalra is léphet egy szomszédos üres mezőre (balra vagy jobbra, ugyanabban a sorban). Nem üt.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik gyalogod lépjen oldalra?' }],
  needsNormalMove: true,
  getTargets: (c) =>
    ownPieces(c.state, c.caster, ['P']).filter((s) => {
      const p = at(c, s);
      if (hasEffect(c.state, p, 'scout')) return false;
      return newMovesWithEffect(c.state, s, {
        kind: 'scout', owner: c.caster, source: 'scout', pieceId: p.id, expiresAfterTurn: T(c),
      }).length > 0;
    }),
  execute: (c, [s]) => pieceBuff(c, s, 'scout', T(c), 'scout'),
  badge: 'Cserkész',
  added: {
    reason: 'Új spell (javaslatból). Balansz: 2 → 1 mana – csak a normál lépésedet teszi rugalmasabbá.',
    proposal: 'Egy gyalogod oldalirányba is léphet egy üres mezőre (nem üt).',
    proposalCost: 2,
  },
};

const manaThirst: Spell = {
  id: 'manaThirst', number: 66, name: 'Mana-szomj', manaCost: 3, category: 'Mana', icon: '🧪',
  description: 'Ha ebben a körben leütsz egy ellenséges bábut (lépéssel, lövéssel vagy spell-lépéssel), a leütött bábu értékének megfelelő extra manát kapsz (gyalog/rabszolga 1, huszár/futó 3, bástya 5, vezér 9 – a maximum feletti rész elvész). Csak az első ütésre érvényes.',
  targetType: 'none', steps: [],
  canCast: (c) => !colorHas(c.state, c.caster, 'manaThirst'),
  execute: (c) => {
    addEffect(c.state, { kind: 'manaThirst', owner: c.caster, source: 'manaThirst', color: c.caster, expiresAfterTurn: T(c) });
  },
  added: { reason: 'Új spell (javaslatból): cserék és nagy ütések előtt éri meg.' },
};

const retrain: Spell = {
  id: 'retrain', number: 67, name: 'Átképzés', manaCost: 2, category: 'Taktika', icon: '🎓',
  description: 'Egy saját huszárod futóvá, vagy egy saját futód huszárrá változik ugyanazon a mezőn. A típushoz kötött hatások (Futóáldás, Futólövész) elvesznek.',
  targetType: 'ownPiece', steps: [{ prompt: 'Melyik huszárt vagy futót képzed át?' }],
  // „Végzet”: no retraining into a kind of piece that was erased
  getTargets: (c) => ownPieces(c.state, c.caster, ['N', 'B']).filter((s) => !isLostType(c.state, c.caster, at(c, s).type === 'N' ? 'B' : 'N')),
  execute: (c, [s]) => {
    const p = at(c, s);
    p.type = p.type === 'N' ? 'B' : 'N';
    c.state.effects = c.state.effects.filter((e) => !(e.pieceId === p.id && (e.kind === 'bishopBlessing' || e.kind === 'sniper')));
    emit(c.state, { type: 'promotion', square: s, piece: p.type });
  },
  added: {
    reason: 'Új spell (javaslatból). Balansz: 3 → 2 mana – a huszár és a futó nagyjából egyenértékű, ez csak helyzeti előny.',
    proposal: 'Egy saját huszárodat átváltoztathatod futóvá (vagy fordítva) a meglévő mezőjén.',
    proposalCost: 3,
  },
};

/** „Vihar”: enemy pawns/servants step back towards their own side – rear ones first so chains move. */
function stormMoves(state: GameState, caster: Color): [Square, Square][] {
  const opp = opposite(caster);
  const ctx = buildCtx(state);
  const occupied = state.board.map((p) => !!p);
  const pawns = ownPieces(state, opp, ['P', 'S']).sort((a, b) => relRank(opp, a) - relRank(opp, b));
  const out: [Square, Square][] = [];
  for (const s of pawns) {
    const r = rankOf(s) - pawnDir(opp);
    if (r < 0 || r > 7) continue;
    const t = sq(fileOf(s), r);
    const p = state.board[s]!;
    if (occupied[t] || ctx.walls.has(t) || ctx.reserved.has(t) || (p.type === 'P' && !pawnSquareOk(opp, t))) continue;
    occupied[s] = false;
    occupied[t] = true;
    out.push([s, t]);
  }
  return out;
}

const storm: Spell = {
  id: 'storm', number: 68, name: 'Vihar', manaCost: 4, category: 'Irányítás', icon: '🌪️',
  description: 'Az összes ellenséges gyalog és rabszolga egy mezőt hátrál a saját oldala felé, ha mögötte üres a mező (egymás mögötti gyalogok közül a hátsó lép előbb). Gyalog nem kerülhet az alapsorra; a kezdősorra visszatolt gyalog újra kettőt léphet.',
  targetType: 'none', steps: [],
  canCast: (c) => stormMoves(c.state, c.caster).length > 0,
  execute: (c) => {
    const moves = stormMoves(c.state, c.caster);
    for (const [f, t] of moves) {
      const p = c.state.board[f]!;
      c.state.board[t] = p;
      c.state.board[f] = null;
      p.prevSquare = f;
      emit(c.state, { type: 'move', pieceId: p.id, from: f, to: t });
    }
    c.state.turnState.irreversible = true;
    emit(c.state, { type: 'spell', spellId: 'storm', color: c.caster, squares: moves.map(([, t]) => t) });
  },
  added: { reason: 'Új spell (javaslatból): a Földrengés egyoldalú, visszafelé ható párja – tempót nyer és szétszedi az előretolt gyalogokat.' },
};

const PROTECTION_KINDS = ['immune', 'fortified', 'spellWard'] as const;

function pushBackSquare(state: GameState, s: Square): Square | null {
  const p = state.board[s];
  if (!p) return null;
  return nudgeTarget(state, s, [0, -pawnDir(p.color)]);
}

const shieldBreaker: Spell = {
  id: 'shieldBreaker', number: 69, name: 'Pajzsromboló', manaCost: 3, category: 'Pusztítás', icon: '🔨',
  description: 'Egy ellenséges (nem király) báburól eltávolítod az összes védelmet (Gyalog-/Huszárpajzs, Megerősítés, Utolsó esély, Láthatatlanság), majd egy mezővel hátrébb löködöd a saját oldala felé, ha ott üres a mező. Láthatatlan bábut is célozhat.',
  targetType: 'enemyPiece', steps: [{ prompt: 'Kinek a védelmét rombolod le?' }],
  ignoresWard: true,
  getTargets: (c) =>
    movableEnemy(c).filter(
      (s) => PROTECTION_KINDS.some((k) => hasEffect(c.state, at(c, s), k)) || pushBackSquare(c.state, s) !== null,
    ),
  execute: (c, [s]) => {
    const p = at(c, s);
    const had = c.state.effects.filter((e) => e.pieceId === p.id && (PROTECTION_KINDS as readonly string[]).includes(e.kind));
    if (had.length) {
      c.state.effects = c.state.effects.filter((e) => !had.includes(e));
      addLog(c.state, c.caster, 'spell', `A(z) ${PIECE_NAME_HU[p.type]} (${squareName(s)}) védelme megsemmisült.`);
    }
    const back = pushBackSquare(c.state, s);
    if (back !== null) relocate(c.state, s, back);
  },
  added: {
    reason: 'Új spell (javaslatból). Balansz: 4 → 3 mana; a Láthatatlanság ellenszere is.',
    proposal: 'Megsemmisíted a célzott ellenséges bábu összes aktív pajzsát és megerősítését, majd 1 mezővel hátrébb lököd.',
    proposalCost: 4,
  },
};

/** „Gravitációs kút”: every non-king piece exactly 2 squares away slides one square towards the centre. */
function wellMoves(state: GameState, center: Square): [Square, Square][] {
  const ctx = buildCtx(state);
  const cands: [Square, Square][] = [];
  for (let s = 0; s < 64; s++) {
    const p = state.board[s];
    if (!p || p.type === 'K' || chebyshev(s, center) !== 2) continue;
    const t = sq(fileOf(s) + Math.sign(fileOf(center) - fileOf(s)), rankOf(s) + Math.sign(rankOf(center) - rankOf(s)));
    if (state.board[t] || ctx.walls.has(t) || ctx.reserved.has(t) || (p.type === 'P' && !pawnSquareOk(p.color, t))) continue;
    cands.push([s, t]);
  }
  // Two pieces heading for the same square both stay put.
  return cands.filter(([, t]) => cands.filter(([, u]) => u === t).length === 1);
}

const gravityWell: Spell = {
  id: 'gravityWell', number: 70, name: 'Gravitációs kút', manaCost: 4, category: 'Terep', icon: '🕳️',
  description: 'Kijelölsz egy mezőt: minden tőle pontosan 2 mezőnyire álló nem király bábu (mindkét színből) egy mezőt csúszik a kút felé, ha a célmező üres. Ha két bábu ugyanoda érkezne, egyik sem mozdul; gyalog nem kerülhet az 1./8. sorra.',
  targetType: 'anySquare', steps: [{ prompt: 'Hová nyitod a gravitációs kutat?' }],
  getTargets: (c) => Array.from({ length: 64 }, (_, i) => i).filter((s) => wellMoves(c.state, s).length > 0),
  execute: (c, [center]) => {
    const moves = wellMoves(c.state, center);
    const pieces = moves.map(([f]) => c.state.board[f]!);
    moves.forEach(([f]) => (c.state.board[f] = null));
    moves.forEach(([f, t], i) => {
      const p = pieces[i];
      c.state.board[t] = p;
      p.prevSquare = f;
      p.hasMoved = true;
      if (p.type === 'P') c.state.turnState.irreversible = true;
      emit(c.state, { type: 'move', pieceId: p.id, from: f, to: t });
    });
  },
  added: {
    reason: 'Új spell (javaslatból). Pontosítva: „2 mezőnyire” = pontosan 2 királylépésnyi távolságra. Balansz: 5 → 4 mana, mert mindkét fél bábuit mozgatja.',
    proposal: 'Kijelölsz egy mezőt: a tőle 2 mezőnyire lévő összes bábu (mindkét oldalon) 1 mezővel a kút közepe felé húzódik.',
    proposalCost: 5,
  },
};

const manaArmageddon: Spell = {
  id: 'manaArmageddon', number: 71, name: 'Mana-armageddon', manaCost: 4, category: 'Mana', icon: '☢️',
  description: 'Mindkét játékos manája azonnal 0-ra csökken (a tiéd a spell ára után), és a következő körben egyikőtök sem kap alap manát (az ellenfél a következő, te a rákövetkező körödben). A Mana mágus és a Mana-letét ettől még fizet.',
  targetType: 'none', steps: [],
  canCast: (c) => c.state.players[c.opp].mana > 0 && !globalHas(c.state, 'manaFamine'),
  execute: (c) => {
    loseMana(c.state, c.caster, c.state.players[c.caster].mana, 'Mana-armageddon');
    loseMana(c.state, c.opp, c.state.players[c.opp].mana, 'Mana-armageddon');
    addEffect(c.state, { kind: 'manaFamine', owner: c.caster, source: 'manaArmageddon', expiresAfterTurn: T(c) + 2 });
  },
  added: {
    reason: 'Új spell (javaslatból). Balansz: 5 → 4 mana, hogy ne csak teli manával lehessen kijátszani – a nagy „ultik” (Meteor, Valóságtörés) ellenszere.',
    proposal: 'Mindkét játékos manája 0-ra csökken, és a következő körben senki sem kap alap manát.',
    proposalCost: 5,
  },
};

export const DRAGON_FIRE_BUDGET = 4;

function diagonalPath(from: Square, toward: Square): Square[] {
  const step = lineStep(from, toward);
  if (!step || step[0] === 0 || step[1] === 0) return [];
  const out = [from];
  let f = fileOf(from) + step[0];
  let r = rankOf(from) + step[1];
  while (onBoard(f, r)) {
    out.push(sq(f, r));
    f += step[0];
    r += step[1];
  }
  return out;
}

const burnable = (state: GameState, s: Square) => {
  const p = state.board[s];
  return !!p && p.type !== 'K';
};

const dragonFire: Spell = {
  id: 'dragonFire', number: 72, name: 'Sárkánytűz', manaCost: 6, category: 'Pusztítás', icon: '🐉',
  change: {
    original: 'Az útjába eső nem király bábuk elpusztulnak, összesen legfeljebb 9 pontnyi anyag.',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a Sárkánytüzes pakli a játszmák 80%-át nyerte, 5 pontos korláttal még 61–70%-ot. Most 4 pont, mint a Meteornál: bástyát, vezért a tűz átugorja.',
  },
  description: `Tűzcsóvát indítasz egy általad választott mezőről egy átlós irányban a tábla széléig: az útjába eső nem király bábuk (mindkét színből) elpusztulnak, összesen legfeljebb ${DRAGON_FIRE_BUDGET} pontnyi anyag, az út sorrendjében – ami már nem fér bele (bástya, vezér soha), azt a tűz átugorja. A pajzs véd, a megerősítés elnyeli.`,
  targetType: 'twoSquares',
  steps: [{ prompt: 'Honnan induljon a tűz?' }, { prompt: 'Merre söpörjön végig? (válassz egy mezőt az átlón)' }],
  getTargets: (c, picked) => {
    const rayTargets = (from: Square) =>
      rays(from, DIAG).filter((t) => diagonalPath(from, t).some((x) => burnable(c.state, x)));
    if (picked.length === 0) return Array.from({ length: 64 }, (_, i) => i).filter((s) => rayTargets(s).length > 0);
    return rayTargets(picked[0]);
  },
  execute: (c, [from, toward]) => {
    const path = diagonalPath(from, toward);
    let budget = DRAGON_FIRE_BUDGET;
    for (const s of path) {
      const p = c.state.board[s];
      if (!p || p.type === 'K') continue;
      const v = PIECE_VALUE[p.type];
      if (v > budget) continue;
      if (destroyByAttack(c.state, s, c.caster) === 'destroyed') budget -= v;
    }
    emit(c.state, { type: 'spell', spellId: 'dragonFire', color: c.caster, squares: path });
  },
  added: {
    reason: `Új spell (javaslatból). Pontosítva és gyengítve: a tűz egy választott mezőtől egy átlós irányban söpör végig, és a Meteorhoz hasonlóan legfeljebb ${DRAGON_FIRE_BUDGET} pontnyi anyagot pusztít (különben egy lövéssel fél sereg eltűnhetne).`,
    proposal: 'Kijelölsz egy teljes átlót: az azon álló összes nem-király bábu (mindkét színből) elpusztul.',
  },
};

/** Enemy pawns and slaves standing on the caster's half of the board (their ranks 1–4). */
const judged = (c: SpellContext): Square[] =>
  enemyPieces(c.state, c.caster, ['P', 'S']).filter((s) => relRank(c.caster, s) <= 3);

/**
 * The order the Reaper takes its victims: always the nearest one next, starting from the
 * caster's king (ties: lower square first). The event lists the squares in this order.
 */
export function reaperPath(from: Square, targets: Square[]): Square[] {
  const left = [...targets].sort((a, b) => a - b);
  const out: Square[] = [];
  let cur = from;
  while (left.length) {
    let best = 0;
    let bestD = Infinity;
    left.forEach((s, i) => {
      const d = Math.hypot(fileOf(s) - fileOf(cur), rankOf(s) - rankOf(cur));
      if (d < bestD - 1e-9) {
        bestD = d;
        best = i;
      }
    });
    cur = left.splice(best, 1)[0];
    out.push(cur);
  }
  return out;
}

const doomsday: Spell = {
  id: 'doomsday', number: 73, name: 'Végítélet', manaCost: 4, category: 'Pusztítás', icon: '☠️',
  description: 'Minden ellenséges gyalog és rabszolga elpusztul, amely a te térfeleden (a saját szemszögedből az 1–4. sorban) áll – a Kaszás egyenként végez velük. A pajzs véd, a megerősítés elnyeli.',
  targetType: 'none', steps: [],
  canCast: (c) => judged(c).length > 0,
  execute: (c) => {
    const squares = reaperPath(findKing(c.state.board, c.caster), judged(c));
    for (const s of squares) destroyByAttack(c.state, s, c.caster);
    emit(c.state, { type: 'spell', spellId: 'doomsday', color: c.caster, squares });
  },
  added: { reason: 'Új spell (javaslatból): a térfeledre betört gyalogok – gyalogroham, előretolt szabad gyalogok – ellenszere.' },
  change: {
    original: 'Minden gyalog és rabszolga a táblán (mindkét színből) elpusztul. A pajzs véd, a megerősítés elnyeli.',
    reason: 'Módosítás (kérésre): az eredeti változat a saját gyalogjaidat – a királyod előtti gyalogfalat is – elvitte, így 6 manáért többnyire semmit sem ért. Most csak a te térfeleden álló ellenséges gyalogokat és rabszolgákat sújtja, 5 manáért. Egyensúly-teszt (1000 AI-játszma, véletlen paklik): így is csak 38–40%-ot ért el (ritkán van célpontja), ezért 4 mana.',
    originalCost: 6,
  },
};

/** „Üvegátok”: capturing is a trade for the cursed piece – it breaks right after its capture. */
const glassCurse: Spell = {
  id: 'glassCurse', number: 74, name: 'Üvegátok', manaCost: 2, costLabel: '2–3', category: 'Irányítás', icon: '💠',
  description:
    'Egy ellenséges (nem király) bábut üveggé átkozol az ellenfél következő körének végéig: ha ezalatt leüt valamit (akár spell segítségével is), az ütés után maga is darabokra törik – ezt pajzs vagy megerősítés sem akadályozza meg. Ára 2 mana, vezérre 3.',
  targetType: 'enemyPiece', steps: [{ prompt: 'Üvegátok: melyik ellenséges bábut átkozod meg?' }],
  badge: 'Üveg',
  costFor: (c, [s]) => (c.state.board[s]?.type === 'Q' ? 3 : 2),
  // clones already vanish after a capture, slaves never capture: no point cursing them
  getTargets: (c) =>
    enemyPieces(c.state, c.caster, ['Q', 'R', 'B', 'N', 'P']).filter((s) => {
      const p = at(c, s);
      return !p.clone && !hasEffect(c.state, p, 'glassCursed');
    }),
  execute: (c, [s]) => pieceBuff(c, s, 'glassCursed', T(c) + 1, 'glassCurse'),
  added: {
    reason: 'Új spell (kérésre): elrettentés – amíg az átok tart, az átkozott bábu minden ütése csere. Vezérre 3 mana, mert ott a legnagyobb a tét.',
  },
};

/**
 * „Végzet” shockwave: every non-king piece next to `center` is pushed one square straight away
 * from it (all at once, judged on the current board), if the square it would land on is free.
 */
export function shockwaveMoves(state: GameState, center: Square): [Square, Square][] {
  const ctx = buildCtx(state);
  const out: [Square, Square][] = [];
  for (const n of neighbours(center)) {
    const p = state.board[n];
    if (!p || p.type === 'K') continue;
    const f = 2 * fileOf(n) - fileOf(center);
    const r = 2 * rankOf(n) - rankOf(center);
    if (!onBoard(f, r)) continue;
    const t = sq(f, r);
    if (state.board[t] || ctx.walls.has(t) || ctx.reserved.has(t) || (p.type === 'P' && !pawnSquareOk(p.color, t))) continue;
    out.push([n, t]);
  }
  return out;
}

/**
 * „Végzet”: the piece is destroyed and its neighbours are blown away. The card charges up when it
 * is played; awakened (once it has gone round the deck) it erases the piece from existence instead:
 * nothing can ever bring it back, and an erased officer's kind is lost to its owner for good.
 */
const doom: Spell = {
  id: 'doom', number: 75, name: 'Végzet', manaCost: 6, category: 'Pusztítás', icon: '🌑',
  change: {
    original: 'A sima kijátszás is bármelyik ellenséges (nem király) bábut elpusztíthatta, a vezért is, és egy kijátszás után felébredt.',
    reason: 'Egyensúly-teszt (1000 AI-játszma, véletlen paklik): a Végzetes pakli a játszmák 78%-át nyerte. Lépésenként: a sima kijátszás csak legfeljebb 3 pontos bábut sújthatott (75%), a felébredéshez két sima kijátszás kellett (72%) – a sima forma egymagában is egy Meteornyi erő volt. Most a sima Végzet csak gyalogot vagy rabszolgát sújt (a lökéshullámmal együtt ez a lap feltöltése), a felébredt pedig bármit: a kitörlés a játszma ritka, nagy pillanata.',
  },
  cycles: 2,
  description:
    'Egy ellenséges gyalog vagy rabszolga elpusztul – semmi sem védi meg (sem pajzs, sem megerősítés, sem Láthatatlanság vagy más védőspell). A lökéshullám a körülötte álló 8 mezőn minden nem király bábut (mindkét színből) egy mezővel egyenesen kifelé lök, ha a célmező üres (gyalog nem kerülhet az 1./8. sorra). Az ellenfél +1 manát kap. Körforgás: minden sima kijátszás tölt egyet a lapon; a második után, amikor legközelebb a kezedbe kerül, FELÉBREDVE játszhatod ki – akkor bármelyik nem király bábut sújthatja (bástyát, vezért is), és a bábu kitörlődik a létezésből: semmi sem hozza vissza, és ha tiszt volt, az ellenfél többé nem kaphat ilyen bábut. Utána a lap újra töltődik.',
  awakened: {
    name: 'Felébredt Végzet',
    description:
      'Egy ellenséges (nem király) bábu – akár bástya vagy vezér – kitörlődik a létezésből. Semmi sem védi meg, és semmi sem hozza vissza: sem Nekromancia, sem Visszatekerés. Ha tiszt volt (vezér, bástya, futó, huszár), az ellenfél többé nem kaphat ilyen bábut: gyalogja nem változhat ilyenné, és Klónnal vagy Átképzéssel sem hozhat létre újat. Nem számít leütésnek. A lökéshullám szétveti a szomszédait, az ellenfél +1 manát kap. Kijátszás után a lap újra töltődni kezd (két sima kijátszással).',
  },
  targetType: 'enemyPiece', steps: [{ prompt: 'Végzet: melyik ellenséges bábura sújtson le?' }],
  ignoresWard: true,
  // the plain form takes pawns and slaves only; the awakened one any piece but the king
  getTargets: (c) =>
    enemyPieces(c.state, c.caster, [...NON_KING]).filter((s) => charged(c, 'doom', doom.cycles ?? 1) || PIECE_VALUE[at(c, s).type] <= 1),
  execute: (c, [s]) => {
    const st = c.state;
    const victim = at(c, s);
    if (c.awakened) {
      // awakened: not a kill – the piece ceases to exist, and nothing can ever bring it back
      st.board[s] = null;
      removePieceEffects(st, victim.id);
      st.erased.push({ ...victim });
      st.turnState.irreversible = true;
      emit(st, { type: 'erase', square: s, piece: { ...victim } });
      addLog(st, c.caster, 'spell', `A(z) ${PIECE_NAME_HU[victim.type]} (${squareName(s)}) megszűnt létezni.`);
      if (isLostType(st, c.opp, victim.type)) {
        const into = INTO_HU[victim.type as PromotionPiece];
        addLog(st, c.opp, 'system', `${COLOR_NAME_HU[c.opp]} többé nem kaphat ilyen bábut: gyalog nem változhat ${into}, Klón vagy Átképzés sem hozhat létre újat.`);
      }
    } else {
      // the plain form: a spell kill like any other – the piece may still come back
      removeFromBoard(st, s);
      addLog(st, c.caster, 'capture', `Végzet: a(z) ${PIECE_NAME_HU[victim.type]} (${squareName(s)}) elpusztult.`);
    }
    // the price of erasing something from existence: the opponent is paid 1 mana
    const got = gainMana(st, c.opp, 1, 'Végzet');
    addLog(st, c.opp, 'mana', got ? `Végzet: ${COLOR_NAME_HU[c.opp]} cserébe +1 manát kapott.` : `Végzet: ${COLOR_NAME_HU[c.opp]} manája tele – a +1 elveszett.`);
    const moves = shockwaveMoves(st, s);
    const pieces = moves.map(([f]) => st.board[f]!);
    moves.forEach(([f]) => (st.board[f] = null));
    moves.forEach(([f, t], i) => {
      const p = pieces[i];
      st.board[t] = p;
      p.prevSquare = f;
      p.hasMoved = true;
      if (p.type === 'P') st.turnState.irreversible = true;
      emit(st, { type: 'move', pieceId: p.id, from: f, to: t });
    });
    emit(st, { type: 'spell', spellId: 'doom', color: c.caster, squares: [s], ...(c.awakened ? { awakened: true } : {}) });
  },
  added: {
    reason: 'Új spell (kérésre): a végső csapás – felébredve a bábu nem leütve, hanem kitörölve a játék történetéből, és ha tiszt volt, a fajtája is (nem lehet belőle új); a lökéshullám szétveti a szomszédait. Balansz (kérésre): az ellenfél +1 manát kap, és a kitörléshez (a mozis animációval együtt) a lapot egyszer körbe kell forgatni – az első kijátszás „csak” elpusztítja a bábut.',
  },
};

export const SPELL_LIST: Spell[] = [
  pawnRush, knightLeap, bishopBlessing, rookCharge, queenGrace, kingStride, pawnShield, knightShield, fortify,
  sacrifice, forcedMarch, teleport, swap, emergencySwap, stepBack, doubleMove, instantPromotion, royalGuard,
  checkBreaker, recastle, deathMark, weaken, root, blindSpot, silence, manaDrain, disarm, pawnFreeze,
  wall, barricade, gravity, chaos, mirror, timeStop, rewind, earthquake, dimensionShift, bloodPrice, overcharge,
  arcaneSurge, gambit, lastChance, execution, meteor, necromancy, realityBreak, brigade, clone,
  frenchCheese, bishopSniper, manaMage, mine, outOfWay, quickCastle, pawnVault, provoke, invisibility, magnet, repulse,
  manaDeposit, scout, manaThirst, retrain, storm, shieldBreaker, gravityWell, manaArmageddon, dragonFire, doomsday,
  glassCurse, doom,
];

/** Spells removed from the original design (kept for documentation and saved-deck migration). */
export const REMOVED_SPELLS: { id: string; number: number; name: string; reason: string; replacement: SpellId }[] = [
  { id: 'pin', number: 23, name: 'Tűzés', reason: 'Kivéve a játékból (kérésre).', replacement: 'weaken' },
  { id: 'manaSteal', number: 28, name: 'Manalopás', reason: 'Kivéve a játékból (kérésre).', replacement: 'manaDrain' },
  {
    id: 'doubleOrNothing', number: 45, name: 'Dupla vagy semmi',
    reason: 'Kivéve a játékból (kérésre): a szerencsén alapuló spellek nem illenek a játékba.', replacement: 'arcaneSurge',
  },
  {
    id: 'fog', number: 33, name: 'Ködfátyol',
    reason: 'Kivéve a játékból (kérésre): egy gépen játszva a rejtés semmit sem ér, mert mindkét játékos ugyanazt a képernyőt látja.',
    replacement: 'invisibility',
  },
];


/**
 * Proposals from the 50-spell suggestion list that were NOT added, with the reason
 * (mostly: too similar to an existing spell, or it has no effect in this game).
 */
export const SKIPPED_PROPOSALS: { number: number; name: string; cost: number; reason: string }[] = [
  { number: 2, name: 'Kőfallépés', cost: 1, reason: 'Túl hasonló a Gyalogpajzshoz.' },
  { number: 3, name: 'Kémlelés', cost: 1, reason: 'A kezek mindkét játékos számára láthatók, nincs rejtett információ.' },
  { number: 4, name: 'Mini Túltöltés', cost: 1, reason: 'Ugyanaz a szerep, mint a Mana-letété (az bekerült).' },
  { number: 6, name: 'Sötétben tapogatózás', cost: 1, reason: 'A felület nem jelöli a támadott mezőket, így nincs mit elrejteni.' },
  { number: 7, name: 'Lendület', cost: 1, reason: 'A sakkbábuknak nincs irányuk – a spellnek nem lenne hatása.' },
  { number: 9, name: 'Bástyaugrás', cost: 2, reason: 'Túl hasonló a Futóáldáshoz (ugyanez bástyával).' },
  { number: 11, name: 'Súlyosbítás', cost: 2, reason: 'Túl hasonló a Halálbélyeghez, és 2 manáért +1 mana veszteséges.' },
  { number: 15, name: 'Huszárugratás', cost: 2, reason: 'Túl hasonló a Dupla lépéshez és a Huszárugráshoz.' },
  { number: 16, name: 'Földbefagyasztás', cost: 2, reason: 'Nincs „bónusz mozgás”; területi fagyasztásként a Gyengítés/Gyalogfagyasztás ismétlése lenne.' },
  { number: 18, name: 'Tűzfal', cost: 3, reason: 'Túl hasonló a Falhoz és a Barikádhoz.' },
  { number: 19, name: 'Gyorsítás', cost: 3, reason: 'Túl hasonló a Dupla lépéshez.' },
  { number: 20, name: 'Tükörpajzs', cost: 3, reason: 'A Láthatatlanság (bekerült) ugyanezt a szerepet tölti be, egyértelműbben.' },
  { number: 21, name: 'Gyengítő Átok', cost: 3, reason: 'Túl hasonló a Dimenzióváltáshoz (csak huszárként léphet) és a Gyengítéshez.' },
  { number: 24, name: 'Szentjánosbogár', cost: 3, reason: 'Túl hasonló a Láthatatlansághoz.' },
  { number: 25, name: 'Vonalzár', cost: 3, reason: 'Nagyon szűk hatás, a Fal/Barikád jobban lefedi.' },
  { number: 26, name: 'Kettős fenyegetés', cost: 3, reason: 'Kétszeres Erőltetett menet.' },
  { number: 27, name: 'Tértranszfer', cost: 4, reason: 'Ugyanaz, mint a Csere.' },
  { number: 29, name: 'Kővé dermesztés', cost: 4, reason: 'Túl hasonló a Gyengítéshez.' },
  { number: 30, name: 'Sötét Alku', cost: 4, reason: 'Túl hasonló a Vérárhoz.' },
  { number: 32, name: 'Főnix', cost: 4, reason: 'Túl hasonló a Megerősítéshez és a Nekromanciához.' },
  { number: 33, name: 'Illúziófal', cost: 4, reason: 'Túl hasonló a Barikádhoz.' },
  { number: 34, name: 'Időhúzás', cost: 4, reason: 'A játékban nincs sakkóra.' },
  { number: 35, name: 'Árnyéklépés', cost: 4, reason: 'Túl hasonló a Dupla lépéshez.' },
  { number: 36, name: 'Metamorfózis', cost: 5, reason: 'Túl hasonló az Azonnali átváltozáshoz.' },
  { number: 37, name: 'Láncvillám', cost: 5, reason: 'Túl hasonló a Meteorhoz.' },
  { number: 38, name: 'Belső Lázadás', cost: 5, reason: 'Túl hasonló a Gyengítéshez.' },
  { number: 39, name: 'Szentély', cost: 5, reason: 'A Láthatatlanság és az Utolsó esély együtt lefedi.' },
  { number: 42, name: 'Kettős Idézés', cost: 5, reason: 'Túl hasonló a Túltöltéshez, és két ingyen spell egy körben túl erős.' },
  { number: 43, name: 'Képlékeny Tábla', cost: 5, reason: 'Két üres terület cseréje nem változtat semmit.' },
  { number: 45, name: 'Feltámadás', cost: 6, reason: 'Túl hasonló a Nekromanciához.' },
  { number: 46, name: 'Mindentudás', cost: 6, reason: 'Túl hasonló a Valóságtöréshez.' },
  { number: 47, name: 'Térhajlítás', cost: 6, reason: 'Túl hasonló a Cseréhez és a Teleporthoz.' },
  { number: 48, name: 'Abszolút Zárás', cost: 6, reason: 'Túl hasonló az Időmegállításhoz.' },
  { number: 49, name: 'Kereszttűz', cost: 6, reason: 'Nem egyértelmű leírás; a Futólövész hasonló szerepet tölt be.' },
];
