import { z } from 'zod/v4';
import { check, requiredBits } from './wire.mjs';

export const coinInput = z.string().max(79).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/,
  'Use a positive coin amount as text, with at most eight decimal places.');
export function units(coins) {
  check(coinInput.safeParse(coins).success, 'Use a positive coin amount as text, with at most eight decimal places.');
  const [whole, fraction = ''] = coins.split('.');
  const result = (BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))).toString();
  check(result !== '0' && result.length <= 78, 'Amount must be positive and fit within 78 integer-unit digits.');
  return result;
}
const wireAmount = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/);
export function coins(value) {
  check(wireAmount.safeParse(value).success, 'Gateway state is inconsistent: invalid amount.');
  return `${BigInt(value) / 100000000n}.${(BigInt(value) % 100000000n).toString().padStart(8, '0')}`;
}
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const stateSchema = z.object({
  tip: z.object({ height: integer, hash }), counted: integer,
  bits: z.record(z.string(), integer.max(32)), capacity_left: integer, per_address: integer.positive(),
  params: z.object({ capacity: integer.positive(), per_address: integer.positive(), exit_wait: integer.positive(),
    min_amount: z.string().regex(/^[1-9][0-9]{0,15}$/) }),
  lottery: z.object({ start: integer.positive(), end: integer.positive(), blocks: integer.positive(), winners: integer.positive(),
    open_targets: z.array(z.object({ tb: integer, guesses: integer, accepting: z.boolean(), capacity_left: integer })).max(2016) }),
  mine: z.object({ r: integer, start: integer, claim_end: integer, end: integer, window_open: z.boolean(),
    S: wireAmount, C: wireAmount, vein_buffer: wireAmount, last_guideline: wireAmount,
    claim_count: integer, claim_deposit: wireAmount,
    params: z.object({ mine_clean_rounds: integer.positive(), mine_max_strikes: integer.positive() }) })
});
const accountSchema = z.object({ balance: wireAmount, deposit: wireAmount,
  exits: z.array(z.object({ amount: wireAmount, release: integer })).max(256), moves_this_height: integer,
  mine: z.object({ r: integer, claim: z.object({ d: wireAmount, q: integer.max(2000) }).nullable(),
    fair_share_estimate: wireAmount, strikes: integer, clean: integer })
});
export function validateState(raw) {
  const result = stateSchema.safeParse(raw);
  check(result.success, 'Gateway state is inconsistent or incomplete.');
  const s = result.data, m = s.mine, l = s.lottery;
  check(s.counted <= s.tip.height && s.capacity_left <= s.params.capacity && s.per_address === s.params.per_address &&
    l.end === l.start + l.blocks && l.blocks <= 2016 && m.claim_end === m.start + 2 && m.end === m.start + 5 &&
    ((s.tip.height >= m.start && s.tip.height <= m.end) || (m.r === 0 && s.tip.height === m.start - 1)) &&
    m.window_open === (s.tip.height >= m.start && s.tip.height <= m.claim_end), 'Gateway state is inconsistent.');
  for (const type of ['lock', 'unlock', 'withdraw', 'guess', 'claim']) requiredBits(s, type);
  return s;
}
export function validateAccount(raw, state) {
  const result = accountSchema.safeParse(raw);
  check(result.success && result.data.mine.r === state.mine.r, 'Gateway account and state are inconsistent.');
  return result.data;
}
export function statusView(state, account, address) {
  const m = state.mine, l = state.lottery;
  return { message: 'Amounts are coins. Fair share is an estimate; accepted submissions still need settlement.', address,
    tip: state.tip.height, counted: state.counted,
    lottery: { start: l.start, end_exclusive: l.end, next_target: Math.max(l.start, state.tip.height + 3) < l.end ? Math.max(l.start, state.tip.height + 3) : null,
      winners: l.winners },
    mine: { round: m.r, start: m.start, claim_end: m.claim_end, end: m.end, window_open: m.window_open,
      stock: coins(m.S), capacity: coins(m.C), vein: coins(m.vein_buffer), guideline: coins(m.last_guideline),
      claim_count: m.claim_count, claim_deposits: coins(m.claim_deposit) },
    balance: coins(account.balance), deposit: coins(account.deposit),
    exits: account.exits.map(e => ({ amount: coins(e.amount), release: e.release, mature: e.release <= state.counted })),
    strikes: account.mine.strikes, clean_rounds: account.mine.clean, fair_share_estimate: coins(account.mine.fair_share_estimate),
    claim: account.mine.claim && { deposit: coins(account.mine.claim.d), level: account.mine.claim.q },
    difficulty: Object.fromEntries(['lock', 'unlock', 'withdraw', 'guess', 'claim'].map(t => [t, state.bits[t]])),
    capacity_left: state.capacity_left, moves_left: Math.max(0, state.per_address - account.moves_this_height), exit_wait: state.params.exit_wait };
}
