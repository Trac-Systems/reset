// All monetary arithmetic is integer units. Division dust stays in the stock.
export const GAME_INFLOW = 309375000n;
export const ROUND_BLOCKS = 6;
export const CLAIM_BLOCKS = 3;
export const MINE_DEFAULTS = Object.freeze({
  mine_capacity: '44550000000', mine_bonus_per_mille: 100,
  mine_clean_rounds: 24, mine_max_strikes: 4,
  mine_collapse_threshold_per_mille: 100, mine_collapse_loss_per_mille: 50,
  mine_capacity_floor_per_mille: 250
});
export const LOTTERY_DEFAULTS = Object.freeze({ lottery_start_block: 1, lottery_blocks: 144, lottery_winners: 10, guess_bits: 20 });
export const LOTTERY_WINDOW_KEYS = ['lottery_start_block', 'lottery_blocks', 'lottery_winners'];
export const min = (a, b) => a < b ? a : b;
export const max = (a, b) => a > b ? a : b;
export const roundAt = (height, checkpoint = 0) => Math.max(0, Math.floor((height - checkpoint - 1) / ROUND_BLOCKS));
export function roundWindow(r, checkpoint = 0) {
  const start = checkpoint + 1 + r * ROUND_BLOCKS;
  return { r, start, claim_end: start + CLAIM_BLOCKS - 1, end: start + ROUND_BLOCKS - 1 };
}
export function validGameParam(key, value) {
  if (key === 'mine_capacity') return typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) >= 4n;
  if (!Number.isSafeInteger(value)) return false;
  if (key === 'guess_bits') return value >= 0 && value <= 32;
  if (key === 'lottery_start_block') return value >= 1 && value <= 2147483647;
  if (key === 'lottery_blocks') return value >= 1 && value <= 2016;
  if (key === 'lottery_winners') return value >= 1 && value <= 100;
  if (key === 'mine_clean_rounds') return value >= 1 && value <= 1000000;
  if (key === 'mine_max_strikes') return value >= 1 && value <= 100;
  if (key === 'mine_bonus_per_mille') return value >= 0 && value <= 1000;
  if (['mine_collapse_threshold_per_mille', 'mine_collapse_loss_per_mille', 'mine_capacity_floor_per_mille'].includes(key)) return value >= 1 && value <= 1000;
  return false;
}
export const lotteryWindow = params => ({ start: params.lottery_start_block, end: params.lottery_start_block + params.lottery_blocks });
export function checkGuess(p, tip, params, seen, count, limit, pending) {
  const w = lotteryWindow(params);
  if (p.tb < w.start || p.tb >= w.end) return 'lottery_window';
  if (tip > p.tb - 3) return 'guess_late';
  if (pending) return 'lottery_pending';
  if (seen) return 'already_guessed';
  return count >= limit ? 'lottery_capacity' : null;
}
export function checkClaim(p, tip, checkpoint, deposit, seen) {
  const w = roundWindow(roundAt(tip, checkpoint), checkpoint);
  if (p.r !== w.r) return 'mine_round';
  if (tip < w.start || tip > w.claim_end) return 'claim_window';
  if (seen) return 'already_claimed';
  return BigInt(deposit) === 0n ? 'deposit' : null;
}
export function circularDistance(n, hash) {
  const delta = BigInt(`0x${n}`) - BigInt(`0x${hash.slice(-8)}`);
  const distance = delta < 0n ? -delta : delta;
  return Number(min(distance, 4294967296n - distance));
}
export function lotteryPayout(guesses, hash, slots, inflow = GAME_INFLOW) {
  const ranked = guesses.map(g => ({ ...g, distance: circularDistance(g.n, hash) }))
    .sort((a, b) => a.distance - b.distance || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const winners = [];
  let paid = 0n;
  for (let i = 0; i < ranked.length && i < slots;) {
    let end = i + 1;
    while (end < ranked.length && ranked[end].distance === ranked[i].distance) end++;
    const available = Math.min(end - i, slots - i);
    const each = inflow * BigInt(available) / (BigInt(slots) * BigInt(end - i));
    for (let j = i; j < end; j++) winners.push({ ...ranked[j], amount: each.toString() });
    paid += each * BigInt(end - i);
    i = end;
  }
  return { winners, paid: paid.toString(), to_mine: (inflow - paid).toString() };
}
export const veinFound = hash => hash.slice(-3) === hash.slice(-1).repeat(3);
export function addMineInflow(stock, vein, capacity, inflow, hash) {
  const retained = min(inflow, max(0n, capacity - stock));
  stock += retained; vein += inflow - retained;
  const found = veinFound(hash);
  const released = found ? vein : 0n;
  return { stock: stock + released, vein: vein - released, found, released };
}
// The collapse safety arms once the stock has reached half its capacity, so the empty Mine at launch
// is not mistaken for a collapse.
export const mineArmed = (armed, stock, capacity) => armed === true || stock * 2n >= capacity;
export function mineGuideline(stock, capacity, params, armed = true) {
  const collapse = armed && stock * 1000n < capacity * BigInt(params.mine_collapse_threshold_per_mille);
  const nextCapacity = collapse ? max(BigInt(params.mine_capacity) * BigInt(params.mine_capacity_floor_per_mille) / 1000n,
    capacity * BigInt(1000 - params.mine_collapse_loss_per_mille) / 1000n) : capacity;
  const inflow = GAME_INFLOW * BigInt(ROUND_BLOCKS);
  const guideline = min(stock, inflow + (collapse ? 0n : max(0n, stock - capacity / 2n) * BigInt(params.mine_bonus_per_mille) / 1000n));
  return { guideline, capacity: nextCapacity, collapse };
}
// Fair amounts are fixed before any excess is allocated. Unbacked excess cannot
// be paid: otherwise a tiny deposit could collect more than any collectible fine.
export function minePayout(claims, stock, capacity, params, armed = true) {
  const g = mineGuideline(stock, capacity, params, armed);
  const deposits = claims.reduce((s, c) => s + BigInt(c.d), 0n);
  let baseTotal = 0n, excessTotal = 0n;
  const rows = claims.map(c => {
    const fair = deposits === 0n ? 0n : g.guideline * BigInt(c.d) / deposits;
    const requested = fair * BigInt(c.q) / 1000n;
    const base = min(requested, fair);
    const excess = max(0n, requested - fair);
    const backed = min(excess, BigInt(c.collateral));
    let strikes = Math.min(c.strikes ?? 0, params.mine_max_strikes), clean = c.clean ?? 0;
    if (excess > 0n) { strikes = Math.min(params.mine_max_strikes, strikes + 1); clean = 0; }
    else { clean++; if (clean >= params.mine_clean_rounds) { strikes = Math.max(0, strikes - 1); clean = 0; } }
    const penalty = min(BigInt(c.collateral), excess * BigInt(strikes));
    baseTotal += base; excessTotal += backed;
    return { address: c.address, fair, base, backed, penalty, strikes, clean };
  });
  const available = min(stock - baseTotal, excessTotal);
  let paid = 0n, penalties = 0n;
  const results = rows.map(c => {
    const amount = c.base + (excessTotal === 0n ? 0n : available * c.backed / excessTotal);
    paid += amount; penalties += c.penalty;
    return { address: c.address, fair: c.fair.toString(), amount: amount.toString(), penalty: c.penalty.toString(), strikes: c.strikes, clean: c.clean };
  });
  return { results, guideline: g.guideline.toString(), capacity: g.capacity.toString(), collapse: g.collapse,
    paid: paid.toString(), penalties: penalties.toString(), stock: (stock - paid + penalties).toString() };
}
