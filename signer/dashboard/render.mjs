// Server-side HTML for the dashboard. Everything from the gateway is escaped; amounts are shown in coins only.
import { units, int, esc, coins, blocksTime, ago, when, shortAddress } from './format.mjs';

const RECENT_WIN_BLOCKS = 144;
const CHART_POINTS = 360;

const card = (id, title, body, extra = '') => `<section class="card" id="${id}" aria-labelledby="${id}-h"${extra}>
<h2 id="${id}-h">${title}</h2>${body}</section>`;
const row = (label, value, note = '') => `<div class="row"><dt>${label}</dt><dd><span class="num">${value}</span>${note ? `<small>${note}</small>` : ''}</dd></div>`;
const pill = (tone, text) => `<span class="pill ${tone}"><i aria-hidden="true"></i>${text}</span>`;
const empty = text => `<p class="empty">${text}</p>`;

function notice(title, text) {
  return `<section class="card notice" aria-live="polite"><h2>${title}</h2><p>${text}</p></section>`;
}

function header(snap, now) {
  let status;
  if (!snap.address || !snap.gateway) status = pill('warn', 'Not set up');
  else if (snap.error) status = pill('bad', 'Gateway not reachable');
  else if (!snap.state) status = pill('muted', 'Connecting');
  else status = pill('good', `Live · updated ${esc(ago(now - snap.updatedAt))}`);
  const who = snap.address ? `<span class="addr" title="${esc(snap.address)}">${esc(shortAddress(snap.address))}</span>` : '';
  return `<header class="top"><div class="brand"><span class="mark" aria-hidden="true"></span><h1>RESET</h1>${who}</div>
<div class="status"><span data-status>${status}</span><button type="button" class="theme" data-theme-toggle aria-label="Switch light or dark mode">◐</button></div></header>`;
}

function coinsCard(state, account) {
  const counted = int(state.counted) ?? 0;
  const balance = units(account.balance), deposit = units(account.deposit);
  const exits = (Array.isArray(account.exits) ? account.exits : []).filter(e => units(e?.amount) > 0n && int(e?.release) !== null);
  const exiting = exits.reduce((sum, e) => sum + units(e.amount), 0n);
  const total = balance + deposit + exiting;
  if (total === 0n) {
    return card('coins', 'My coins', `<p class="hero num">0</p>${empty('No coins yet. Win some in the lottery, or ask someone to send coins to your address.')}`);
  }
  const list = exits.slice(0, 6).map(e => `<li><span class="num">${coins(e.amount)}</span> ${counted >= e.release
    ? pill('good', 'ready to withdraw') : `<small>releases at block ${e.release} (${blocksTime(e.release - counted)})</small>`}</li>`).join('');
  const more = exits.length > 6 ? `<li><small>and ${exits.length - 6} more</small></li>` : '';
  return card('coins', 'My coins', `<p class="hero num">${coins(total)}</p><p class="sub">in total</p>
<dl>${row('Spendable', coins(balance))}${row('Locked in the Mine', coins(deposit))}${row('Waiting to exit', coins(exiting))}</dl>
${exits.length ? `<ul class="exits">${list}${more}</ul>` : ''}`);
}

function chart(samples) {
  const points = samples.slice(-CHART_POINTS).map(s => ({ h: s.h, t: s.t, mine: units(s.mine), lottery: units(s.lottery), penalties: units(s.penalties) }))
    .map(p => ({ ...p, net: p.mine + p.lottery - p.penalties }));
  if (points.length < 2) return empty('The chart fills in as new blocks are counted.');
  const values = points.map(p => Number(p.net) / 1e8);
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (hi - lo < 1e-8) hi = lo + 1;
  const h0 = points[0].h, span = Math.max(1, points.at(-1).h - h0);
  const xf = p => (p.h - h0) / span, yf = v => (hi - v) / (hi - lo);
  const W = 600, H = 160;
  const xy = points.map((p, i) => [xf(p) * W, yf(values[i]) * H]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const zero = (yf(0) * H).toFixed(1);
  const area = `${line}L${W},${zero}L0,${zero}Z`;
  const data = points.map((p, i) => [+xf(p).toFixed(4), +yf(values[i]).toFixed(4), p.h, coins(p.net, { sign: true }),
    coins(p.mine), coins(p.lottery), coins(p.penalties), when(p.t)]);
  const first = points[0], last = points.at(-1);
  const top = points.reduce((m, p) => p.net > m ? p.net : m, 0n), bottom = points.reduce((m, p) => p.net < m ? p.net : m, 0n);
  const rows = points.slice(-12).reverse().map(p => `<tr><td>${p.h}</td><td>${coins(p.net, { sign: true })}</td><td>${coins(p.mine)}</td><td>${coins(p.lottery)}</td><td>${coins(p.penalties)}</td></tr>`).join('');
  return `<figure class="chart" data-chart data-points="${esc(JSON.stringify(data))}">
<div class="yaxis num" aria-hidden="true"><span>${coins(top)}</span><span>${bottom < 0n ? coins(bottom) : '0'}</span></div>
<div class="plot" role="img" aria-label="Net earnings from block ${first.h} to block ${last.h}: ${esc(coins(first.net, { sign: true }))} to ${esc(coins(last.net, { sign: true }))}">
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
<line class="base" x1="0" x2="${W}" y1="${zero}" y2="${zero}" vector-effect="non-scaling-stroke"/>
<path class="area" d="${area}"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/></svg>
<span class="cross" hidden></span><span class="dot" hidden></span><div class="tip" hidden></div></div>
<div class="xaxis num" aria-hidden="true"><span>block ${first.h}</span><span>block ${last.h}</span></div>
<details data-key="earnings-table"><summary>Show as table</summary><table><thead><tr><th>Block</th><th>Net</th><th>Mine</th><th>Lottery</th><th>Penalties</th></tr></thead><tbody>${rows}</tbody></table></details>
</figure>`;
}

function earningsCard(history, saveError) {
  if (!history?.started) return card('earnings', 'My earnings', empty('Earnings are recorded from the next counted block on.'));
  const t = history.totals, mine = units(t.mine), lottery = units(t.lottery), penalties = units(t.penalties);
  const net = mine + lottery - penalties;
  return card('earnings', 'My earnings', `<p class="hero num">${coins(net, { sign: true })}</p><p class="sub">earned since block ${history.started.h}</p>
<div class="tiles"><div><span>Mine payouts</span><b class="num">${coins(mine, { sign: true })}</b></div>
<div><span>Lottery wins</span><b class="num">${coins(lottery, { sign: true })}</b></div>
<div><span>Penalties</span><b class="num">${penalties > 0n ? coins(-penalties) : '0'}</b></div></div>
${chart(history.samples)}
<p class="foot">History starts at block ${history.started.h} (${esc(when(history.started.t))}), when this dashboard first ran on this computer. Results the gateway still listed then are included.</p>${saveError ? `<p class="banner">Could not save the history file: ${esc(saveError)}</p>` : ''}`, ' data-wide');
}

function mineCard(state, account) {
  const m = state.mine ?? {}, a = account.mine ?? {}, params = m.params ?? {};
  const deposit = units(account.deposit);
  const status = m.window_open ? `${pill('good', 'Claim window open')}<small>until block ${int(m.claim_end) ?? '?'}</small>`
    : `${pill('muted', 'Claim window closed')}<small>next opens at block ${(int(m.end) ?? 0) + 1}</small>`;
  let claim;
  if (a.claim && int(a.claim.q) !== null) claim = `You claimed ${a.claim.q / 10}% of your fair share`;
  else if (deposit === 0n) claim = 'Lock coins to take part';
  else claim = m.window_open ? 'Not claimed yet' : 'No claim this round';
  const r = a.last_result;
  const last = r && int(r.r) !== null ? `Round ${r.r}: received <span class="num">${coins(r.amount)}</span> of a fair share of <span class="num">${coins(r.fair)}</span>${units(r.penalty) > 0n
    ? ` ${pill('warn', `penalty ${coins(r.penalty)}`)}` : ''}` : 'No claim settled yet';
  const strikes = int(a.strikes) ?? 0, maxStrikes = int(params.mine_max_strikes) ?? 4, clean = int(a.clean) ?? 0, cleanRounds = int(params.mine_clean_rounds) ?? 24;
  const dots = Array.from({ length: Math.min(maxStrikes, 10) }, (_, i) => `<i class="${i < strikes ? 'on' : ''}"></i>`).join('');
  const strikeText = strikes ? `${pill('warn', `${strikes} of ${maxStrikes} strikes`)}<small>${clean} of ${cleanRounds} clean rounds until one is forgiven</small>`
    : `${pill('good', 'No strikes')}<small>you have claimed fairly</small>`;
  const S = units(m.S), C = units(m.C);
  const fill = C > 0n ? Number((S * 1000n) / C) / 10 : 0;
  const vein = m.last_vein && int(m.last_vein.height) !== null ? `Block ${m.last_vein.height}: <span class="num">${coins(m.last_vein.amount)}</span> released` : 'No vein found yet';
  return card('mine', `Mine <span class="round">round ${int(m.r) ?? '?'}</span>`, `<p class="state">${status}</p>
<dl>${row('My fair share now', coins(a.fair_share_estimate), 'estimate if the round settled now')}
<div class="row"><dt>This round</dt><dd>${claim}</dd></div>
<div class="row"><dt>My last claim</dt><dd>${last}</dd></div>
<div class="row"><dt>Strikes</dt><dd><span class="strikes" aria-hidden="true">${dots}</span>${strikeText}</dd></div></dl>
<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, fill)}" aria-label="Coins in the Mine against its maximum">
<div class="meter-label"><span>Coins in the Mine</span><span class="num">${coins(S)} of ${coins(C)} max</span></div><div class="bar"><span style="width:${Math.min(100, fill)}%"></span></div></div>
<dl>${row('Vein buffer', coins(m.vein_buffer), 'released when a block hash ends in three equal digits')}
<div class="row"><dt>Last vein</dt><dd>${vein}</dd></div></dl>`);
}

// Shown while the lottery has not ended, or for a day after it while my wins are still listed.
function lotteryCard(state, address) {
  const l = state.lottery;
  const start = int(l?.start), end = int(l?.end), counted = int(state.counted);
  // While the clock catches up, the real Bitcoin height (from the gateway's header source) is the better estimate.
  const heights = [int(state.tip?.height), int(state.source_height)].filter(h => h !== null);
  const tip = heights.length ? Math.max(...heights) : null;
  if (start === null || end === null || counted === null) return '';
  const results = Array.isArray(l.recent_results) ? l.recent_results.filter(x => int(x?.tb) !== null) : [];
  const mineOf = x => (Array.isArray(x.winners) ? x.winners : []).filter(w => w?.address === address);
  const wins = results.flatMap(x => mineOf(x).map(w => ({ tb: x.tb, amount: w.amount, distance: w.distance })));
  const over = counted >= end - 1;
  const recentWins = wins.filter(w => w.tb >= counted - RECENT_WIN_BLOCKS);
  if (over && !recentWins.length) return '';
  const winsList = (over ? recentWins : wins).slice().reverse().map(w => `<li><span>Block ${w.tb}</span><span>won <b class="num">${coins(w.amount)}</b>${int(w.distance) !== null ? ` <small>off by ${w.distance}</small>` : ''}</span></li>`).join('');
  const myWins = winsList ? `<ul class="list">${winsList}</ul>` : empty('No wins in the recent results.');
  if (over) return card('lottery', 'Lottery', `<p class="state">${pill('muted', 'Lottery over')}<small>all new coins now go to the Mine</small></p><h3>My recent wins</h3>${myWins}`);
  if (counted < start) {
    return card('lottery', 'Lottery', `<p class="state">${pill('warn', `Lottery starts at block ${start}`)}<small>${tip !== null ? `${blocksTime(start - tip)} from now` : ''}</small></p>
<p>${int(l.blocks) ?? end - start} blocks, from ${start} to ${end - 1}. For each block the ${int(l.winners) ?? 10} closest guesses share its coins.</p>
${targets(l)}`);
  }
  const done = Math.max(0, counted - start + 1), total = end - start, pct = Math.min(100, (done / total) * 100);
  const recent = results.slice(-6).reverse().map(x => {
    const won = mineOf(x).reduce((s, w) => s + units(w.amount), 0n);
    return `<tr><td>${x.tb}</td><td>${int(x.winner_count) ?? (x.winners?.length ?? 0)}</td><td class="num">${coins(x.paid)}</td><td>${won > 0n ? `<span class="won">won ${coins(won)}</span>` : '\u2014'}</td></tr>`;
  }).join('');
  return card('lottery', 'Lottery', `<p class="state">${pill('good', 'Lottery open')}<small>blocks ${start} to ${end - 1}, ends ${blocksTime(end - 1 - counted)} from now</small></p>
<div class="meter"><div class="meter-label"><span>Blocks done</span><span class="num">${done} of ${total}</span></div><div class="bar"><span style="width:${pct}%"></span></div></div>
${targets(l)}
<h3>My guesses</h3><p class="foot">The gateway does not list guesses per player. Your wins appear here once their block is counted.</p>${myWins}
<h3>Recent results</h3>${recent ? `<div class="scroll"><table><thead><tr><th>Block</th><th>Winners</th><th>Paid</th><th>Me</th></tr></thead><tbody>${recent}</tbody></table></div>` : empty('No block settled yet.')}`);
}

function targets(l) {
  const open = (Array.isArray(l.open_targets) ? l.open_targets : []).filter(t => int(t?.tb) !== null);
  if (!open.length) return '<h3>Open targets</h3>' + empty('No guesses placed yet.');
  const accepting = open.filter(t => t.accepting);
  const guesses = open.reduce((s, t) => s + (int(t.guesses) ?? 0), 0);
  const items = open.slice(0, 8).map(t => `<li>Block ${t.tb} <small>${int(t.guesses) ?? 0} guesses · ${t.accepting ? 'taking guesses' : 'closed, waiting for the block'}</small></li>`).join('');
  return `<h3>Open targets</h3><p>${accepting.length} block${accepting.length === 1 ? '' : 's'} taking guesses, ${guesses} guesses so far.</p><ul class="list">${items}</ul>`;
}

function networkCard(state, snap, now) {
  const gateways = Array.isArray(state.gateways) ? state.gateways : [];
  const active = gateways.filter(g => g?.active === true).length;
  const m = state.mine ?? {};
  return card('network', 'Network', `<dl>${row('Bitcoin tip', `block ${int(state.tip?.height) ?? '?'}`)}
${row('Counted', `block ${int(state.counted) ?? '?'}`)}
<div class="row"><dt>Last new block</dt><dd>${snap.lastBlockAt ? esc(ago(now - snap.lastBlockAt)) : '<small>not seen yet by this dashboard</small>'}</dd></div>
${row('Gateways active', gateways.length ? `${active} of ${gateways.length}` : 'none registered')}
${row('Claims this round', String(int(m.claim_count) ?? 0), `${coins(m.claim_deposit)} locked by claimers`)}</dl>`);
}

export function renderMain(snap, now = Date.now()) {
  const top = header(snap, now);
  if (!snap.address) return top + notice('No address yet', 'Create a wallet with <code>reset-signer init</code>, or start the dashboard with <code>--address</code> or <code>RESET_ADDRESS</code>.');
  if (!snap.gateway) return top + notice('No gateway set', 'Start the dashboard with <code>RESET_GATEWAY_URL</code> pointing at your gateway.');
  if (!snap.state || !snap.account) {
    return top + (snap.error ? notice('Gateway not reachable', `Could not reach ${esc(snap.gateway)}. Retrying every 15 seconds.`)
      : notice('Connecting', `Asking ${esc(snap.gateway)} for the latest state…`));
  }
  const banner = snap.error ? `<p class="banner" role="status">Gateway not reachable. Showing data from ${esc(ago(now - snap.updatedAt))}. Retrying every 15 seconds.</p>` : '';
  return `${top}${banner}<div class="grid">${coinsCard(snap.state, snap.account)}${earningsCard(snap.history, snap.historyError)}${mineCard(snap.state, snap.account)}${lotteryCard(snap.state, snap.address)}${networkCard(snap.state, snap, now)}</div>`;
}

const CSS = `
:root{color-scheme:light;--bg:#f4f3ef;--card:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--ink3:#77766f;--line:#e3e1da;
--accent:#2a78d6;--area:rgba(42,120,214,.12);--good:#16692f;--good-bg:#e1f1e5;--warn:#8a5300;--warn-bg:#f9ecd4;
--bad:#a8261d;--bad-bg:#f9e2df;--muted-bg:#ecebe6;--track:#e8e6df}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--bg:#121211;--card:#1a1a19;
--ink:#fff;--ink2:#c3c2b7;--ink3:#8e8d85;--line:#2d2d2a;--accent:#3987e5;--area:rgba(57,135,229,.18);--good:#7fd396;
--good-bg:#1d3324;--warn:#f0b65c;--warn-bg:#3a2c14;--bad:#f2948b;--bad-bg:#3d1f1c;--muted-bg:#262624;--track:#2a2a27}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--card:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--ink3:#8e8d85;--line:#2d2d2a;
--accent:#3987e5;--area:rgba(57,135,229,.18);--good:#7fd396;--good-bg:#1d3324;--warn:#f0b65c;--warn-bg:#3a2c14;--bad:#f2948b;
--bad-bg:#3d1f1c;--muted-bg:#262624;--track:#2a2a27}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#app{max-width:1080px;margin:0 auto;padding:24px 20px 48px}
.num{font-variant-numeric:tabular-nums}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:12px}.brand h1{font-size:18px;letter-spacing:.14em;margin:0;font-weight:650}
.mark{width:14px;height:14px;border-radius:4px;background:var(--accent);box-shadow:5px 5px 0 -1px var(--area)}
.addr{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2);background:var(--card);border:1px solid var(--line);padding:2px 8px;border-radius:999px}
.status{display:flex;align-items:center;gap:8px}
.theme{background:var(--card);color:var(--ink2);border:1px solid var(--line);border-radius:999px;width:32px;height:32px;font-size:16px;cursor:pointer}
.theme:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;min-width:0}
.card[data-wide]{grid-column:span 2}
@media (max-width:700px){.card[data-wide]{grid-column:auto}#app{padding:16px 12px 40px}}
h2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);margin:0 0 14px}
h2 .round{text-transform:none;letter-spacing:0;color:var(--ink3);font-weight:500;margin-left:6px}
h3{font-size:14px;font-weight:600;margin:18px 0 6px}
p{margin:0 0 10px}small,.foot,.sub{color:var(--ink3);font-size:13px}
.hero{font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1.1;margin:0}.sub{margin:2px 0 14px}
dl{margin:0}.row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:9px 0;border-top:1px solid var(--line)}
.row dt{color:var(--ink2);flex:none}.row dd{margin:0;text-align:right;min-width:0}.row dd small{display:block;margin-top:2px}
.row dd .pill{margin:2px 0}
.empty{color:var(--ink2);background:var(--muted-bg);border-radius:10px;padding:12px 14px;margin:10px 0 0}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:550;padding:3px 10px;border-radius:999px;background:var(--muted-bg);color:var(--ink2);white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%;background:currentColor}
.pill.good{background:var(--good-bg);color:var(--good)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.bad{background:var(--bad-bg);color:var(--bad)}
.state{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px}
.exits,.list{list-style:none;padding:0;margin:8px 0 0}.exits li,.list li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:6px 0;border-top:1px dashed var(--line)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.tiles div{background:var(--bg);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}
.tiles span{font-size:12px;color:var(--ink3)}.tiles b{font-size:17px;font-weight:600;overflow-wrap:anywhere}
.chart{margin:0;display:grid;grid-template-columns:auto 1fr;grid-template-rows:160px auto auto;column-gap:10px}
.yaxis{display:flex;flex-direction:column;justify-content:space-between;font-size:11px;color:var(--ink3);text-align:right}
.plot{position:relative;height:160px;touch-action:none}.plot svg{width:100%;height:100%;display:block;overflow:visible}
.line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.area{fill:var(--area)}
.base{stroke:var(--line);stroke-width:1}
.xaxis{grid-column:2;display:flex;justify-content:space-between;font-size:11px;color:var(--ink3);padding-top:4px}
.chart details{grid-column:1/-1}
.cross{position:absolute;top:0;bottom:0;width:1px;background:var(--ink3);opacity:.5;pointer-events:none}
.dot{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--card);pointer-events:none}
.tip{position:absolute;top:-6px;transform:translate(-50%,-100%);background:var(--ink);color:var(--card);font-size:12px;line-height:1.4;padding:6px 9px;border-radius:8px;white-space:nowrap;pointer-events:none;z-index:2}
details{margin-top:12px}summary{cursor:pointer;color:var(--ink2);font-size:13px}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px;font-variant-numeric:tabular-nums}
.won{color:var(--good);font-weight:600;white-space:nowrap}
th,td{text-align:right;padding:6px 4px;border-top:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--ink3);font-weight:500}
.meter{margin:14px 0}.meter-label{display:flex;justify-content:space-between;font-size:13px;color:var(--ink2);margin-bottom:6px}
.bar{height:8px;background:var(--track);border-radius:999px;overflow:hidden}.bar span{display:block;height:100%;background:var(--accent);border-radius:999px}
.strikes{display:flex;justify-content:flex-end;gap:4px;margin-bottom:4px}.strikes i{width:10px;height:10px;border-radius:3px;border:1.5px solid var(--ink3)}
.strikes i.on{background:var(--warn);border-color:var(--warn)}
.banner{background:var(--bad-bg);color:var(--bad);border-radius:10px;padding:10px 14px;margin-bottom:16px}
.notice{max-width:560px;margin:40px auto}.notice h2{font-size:18px;text-transform:none;letter-spacing:0;color:var(--ink)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--muted-bg);padding:1px 5px;border-radius:5px}
@media (max-width:420px){.tiles{grid-template-columns:1fr}.hero{font-size:28px}}
@media (prefers-reduced-motion:no-preference){.bar span{transition:width .4s ease}}
`;

const SCRIPT = `(() => {
  const root = document.documentElement, app = document.getElementById('app');
  const saved = localStorage.getItem('reset-theme');
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    localStorage.setItem('reset-theme', root.dataset.theme);
  });
  function bindChart() {
    const fig = document.querySelector('[data-chart]');
    if (!fig) return;
    const pts = JSON.parse(fig.dataset.points), plot = fig.querySelector('.plot');
    const cross = plot.querySelector('.cross'), dot = plot.querySelector('.dot'), tip = plot.querySelector('.tip');
    const hide = () => { cross.hidden = dot.hidden = tip.hidden = true; };
    plot.addEventListener('pointermove', e => {
      const box = plot.getBoundingClientRect(), x = (e.clientX - box.left) / box.width;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
      const left = (best[0] * 100) + '%';
      cross.style.left = dot.style.left = tip.style.left = left;
      dot.style.top = (best[1] * 100) + '%';
      tip.textContent = 'Block ' + best[2] + ' \\u00b7 ' + best[3] + '\\nMine ' + best[4] + ' \\u00b7 Lottery ' + best[5] + ' \\u00b7 Penalties ' + best[6];
      tip.style.whiteSpace = 'pre';
      cross.hidden = dot.hidden = tip.hidden = false;
    });
    plot.addEventListener('pointerleave', hide);
  }
  async function refresh() {
    try {
      const res = await fetch('/fragment', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const html = await res.text();
      const open = [...document.querySelectorAll('details[open][data-key]')].map(d => d.dataset.key);
      app.innerHTML = html;
      for (const key of open) document.querySelector('details[data-key="' + key + '"]')?.setAttribute('open', '');
      bindChart();
    } catch {
      const s = document.querySelector('[data-status]');
      if (s) s.innerHTML = '<span class="pill bad"><i aria-hidden="true"></i>Dashboard stopped</span>';
    }
  }
  bindChart();
  setInterval(refresh, 15000);
})();`;

export function renderPage(snap, nonce, now = Date.now()) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>RESET dashboard</title>
<link rel="icon" href="data:,"><style>${CSS}</style></head>
<body><main id="app">${renderMain(snap, now)}</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
