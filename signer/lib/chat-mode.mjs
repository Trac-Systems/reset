// Chat mode: one setting for this wallet, re-read before every chat action, and a registry of the processes that act
// on it, so `chat status` reports what is really running instead of what the setting says.
//
//   off      no chat at all: no chat process runs, no notes, the mining side sees nothing
//   passive  the chat agent reads and writes chat; nothing from the chat reaches the mining side
//   active   as passive, plus typed notes (journal) the mining side reads once per round, and the transfer guard
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultDirectory } from './keystore.mjs';
import { check } from './wire.mjs';

export const MODES = Object.freeze(['off', 'passive', 'active']);
export const CHAT_ROLES = Object.freeze(['chat-agent', 'chat-mcp']);   // must not run while the mode is off
const OWN_FILES = ['journal.jsonl', 'journal-read.json', 'seen.json', 'cursor.json', 'transfers.json'];

export function chatPaths(directory = defaultDirectory()) {
  const dir = join(directory, 'chat');
  return { dir, mode: join(dir, 'mode.json'), run: join(dir, 'run'), journal: join(dir, 'journal.jsonl'),
    journalRead: join(dir, 'journal-read.json'), seen: join(dir, 'seen.json'), cursor: join(dir, 'cursor.json'),
    transfers: join(dir, 'transfers.json') };
}

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  check(st.isDirectory() && !st.isSymbolicLink(), `${path} must be a directory`);
}

// Write-then-rename so readers never see half a file.
export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
export function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Fresh read every call: no caching, so a change is seen by the very next action.
export function readMode(directory) {
  const value = readJsonFile(chatPaths(directory).mode, null);
  if (value === null) return { mode: 'off', generation: 0, changed_at: null };
  check(MODES.includes(value?.mode) && Number.isSafeInteger(value.generation), 'Invalid chat mode file');
  return value;
}
export function requireMode(allowed, directory) {
  const { mode } = readMode(directory);
  if (!allowed.includes(mode)) throw new Error(mode === 'off' ? 'Chat is off. Only the owner can turn it on.'
    : `This needs chat mode ${allowed.join(' or ')}; it is ${mode}. Only the owner can change it.`);
  return mode;
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// Only signal a process that really is one of ours (a reused pid would be someone else's).
function isOurs(pid) {
  if (process.platform === 'win32') return alive(pid);
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return out.status === 0 && /reset-signer/.test(out.stdout);
}

// A process that acts on the mode registers itself and confirms each mode it has applied.
export function register(role, directory) {
  const paths = chatPaths(directory); privateDir(paths.dir); privateDir(paths.run);
  const file = join(paths.run, `${role}-${process.pid}.json`);
  const entry = { pid: process.pid, role, started_at: new Date().toISOString(), applied_generation: -1, applied_mode: null };
  const save = () => writeAtomic(file, JSON.stringify({ ...entry, updated_at: new Date().toISOString() }) + '\n');
  save();
  let removed = false;
  const remove = () => { if (!removed) { removed = true; rmSync(file, { force: true }); } };
  process.once('exit', remove);
  return { applied(mode) { entry.applied_generation = mode.generation; entry.applied_mode = mode.mode; if (!removed) save(); }, remove };
}

// Calls onChange(mode) for the current mode and again whenever it changes; confirms after onChange returns.
export function watchMode(registration, onChange, { directory, everyMs = 500 } = {}) {
  let last = -1, running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const mode = readMode(directory);
      if (mode.generation !== last) { await onChange(mode); last = mode.generation; registration.applied(mode); }
    } catch (error) { process.stderr.write(`chat mode: ${error.message}\n`); }
    finally { running = false; }
  };
  const timer = setInterval(tick, everyMs); timer.unref?.();
  const first = tick();
  return { ready: first, stop() { stopped = true; clearInterval(timer); } };
}

export function listProcesses(directory) {
  const { run } = chatPaths(directory);
  let names = [];
  try { names = readdirSync(run).filter(n => /^[a-z-]+-\d+\.json$/.test(n)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = [];
  for (const name of names) {
    const file = join(run, name);
    let entry; try { entry = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    if (!Number.isSafeInteger(entry?.pid) || !alive(entry.pid)) { rmSync(file, { force: true }); continue; }   // stale
    out.push(entry);
  }
  return out;
}

function clearChatFiles(directory, keep = []) {
  const paths = chatPaths(directory);
  for (const name of OWN_FILES) if (!keep.includes(name)) rmSync(join(paths.dir, name), { force: true });
}

// What is really going on, judged by the processes and files that exist.
export function chatStatus(directory) {
  const mode = readMode(directory), processes = listProcesses(directory), paths = chatPaths(directory);
  let notes = 0;
  try { notes = readFileSync(paths.journal, 'utf8').split('\n').filter(Boolean).length; } catch {}
  const problems = [];
  for (const p of processes) {
    if (mode.mode === 'off' && CHAT_ROLES.includes(p.role)) problems.push(`${p.role} (pid ${p.pid}) is still running`);
    else if (p.applied_generation !== mode.generation) problems.push(`${p.role} (pid ${p.pid}) has not confirmed the current mode yet`);
  }
  if (mode.mode !== 'active' && notes) problems.push(`the journal still holds ${notes} notes`);
  const chatting = processes.filter(p => CHAT_ROLES.includes(p.role) && p.applied_generation === mode.generation);
  return { mode: mode.mode, generation: mode.generation, changed_at: mode.changed_at, consistent: problems.length === 0, problems,
    chatting: chatting.length > 0, journal_notes: notes,
    processes: processes.map(p => ({ role: p.role, pid: p.pid, applied_mode: p.applied_mode, confirmed: p.applied_generation === mode.generation })) };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Owner command. Returns only after every process confirmed the new mode; chat processes that do not stop in time
// when the mode becomes off are terminated. The result is the observed status, never just the setting.
export async function setMode(next, { directory, waitMs = 15000, killWaitMs = 3000 } = {}) {
  check(MODES.includes(next), `Mode must be one of: ${MODES.join(', ')}`);
  const paths = chatPaths(directory); privateDir(paths.dir); privateDir(paths.run);
  const current = readMode(directory);
  const generation = current.generation + 1;
  writeAtomic(paths.mode, JSON.stringify({ mode: next, generation, changed_at: new Date().toISOString() }) + '\n');
  // Leaving active: the journal and the guard's lists go at once. Off also drops the chat cursor.
  if (next !== 'active') clearChatFiles(directory, next === 'passive' ? ['cursor.json', 'seen.json'] : []);
  const deadline = Date.now() + waitMs;
  const pending = () => listProcesses(directory).filter(p =>
    (next === 'off' && CHAT_ROLES.includes(p.role)) || p.applied_generation < generation);
  while (pending().length && Date.now() < deadline) await sleep(200);
  const terminated = [];
  if (next === 'off') for (const p of pending().filter(p => CHAT_ROLES.includes(p.role))) {
    if (!isOurs(p.pid)) continue;
    try { process.kill(p.pid, 'SIGTERM'); } catch {}
    const until = Date.now() + killWaitMs;
    while (alive(p.pid) && Date.now() < until) await sleep(100);
    if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch {} await sleep(200); }
    terminated.push({ role: p.role, pid: p.pid, stopped: !alive(p.pid) });
  }
  if (next !== 'active') clearChatFiles(directory, next === 'passive' ? ['cursor.json', 'seen.json'] : []);  // a late writer
  return { ...chatStatus(directory), ...(terminated.length ? { terminated } : {}) };
}
