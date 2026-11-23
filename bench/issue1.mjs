// Issue #1 experiment shortlist runner: baseline vs candidate tool, same
// fixture, same prompt, opencode-go models, >=5 reps per cell.
//
// Usage:
//   OPENCODE_GO_KEY=... node bench/issue1.mjs [--reps N] [--exps a,b]
//        [--models id1,id2] [--arms BASE,TOOL] [--out PATH] [--timeout S]
//        [--scratch DIR] [--force]
//
// - Resumable: cells already recorded in --out are skipped unless --force.
// - One agent at a time (serial loop). Guards MemAvailable >= 4 GB and
//   /home free >= 25 GB before every run; waits (bounded) when low.
// - Fixtures: copied fresh per run from bench/fixtures/issue1/<fx>/,
//   git-dependent state created by setup.sh (deleted after setup), integrity
//   verified by hashing the work tree before/after the run
//   (excluding .git/.cap/__pycache__/opencode.json/.opencode).
// - Serving model read back from the opencode session database per run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPS, TAIL } from './issue1-exps.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(LIB, 'bin');
const PROTO = join(LIB, 'bench', 'proto');
const FIXTURES = join(LIB, 'bench', 'fixtures', 'issue1');
const OC_DB = join(process.env.HOME, '.local/share/opencode/opencode.db');

// ---------------------------------------------------------------- options
const opt = { reps: 5, exps: Object.keys(EXPS), models: ['deepseek-v4.1-flash', 'glm-5.3'], arms: ['BASE', 'TOOL'], out: join(LIB, 'bench/results/issue1/results.jsonl'), timeout: 420, scratch: '/tmp/issue1-runs', force: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--reps') opt.reps = +process.argv[++i];
  else if (a === '--exps') opt.exps = process.argv[++i].split(',');
  else if (a === '--models') opt.models = process.argv[++i].split(',');
  else if (a === '--arms') opt.arms = process.argv[++i].split(',');
  else if (a === '--out') opt.out = process.argv[++i];
  else if (a === '--timeout') opt.timeout = +process.argv[++i];
  else if (a === '--scratch') opt.scratch = process.argv[++i];
  else if (a === '--force') opt.force = true;
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
for (const k of opt.exps) if (!EXPS[k]) { console.error(`unknown exp ${k}`); process.exit(2); }
if (!process.env.OPENCODE_GO_KEY) { console.error('OPENCODE_GO_KEY env required'); process.exit(2); }

// ---------------------------------------------------------------- helpers
const EXCLUDE = new Set(['.git', '.cap', '__pycache__', 'opencode.json', '.opencode']);
function hashTree(dir) {
  const hashes = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name)) continue;
      const full = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) hashes[r] = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16);
    }
  };
  walk(dir, '');
  return hashes;
}
const sameTree = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
};

function resourcesOk() {
  const mem = readFileSync('/proc/meminfo', 'utf8');
  const availKb = +(mem.match(/MemAvailable:\s+(\d+) kB/)?.[1] || 0);
  const df = spawnSync('df', ['--output=avail', '-B1G', process.env.HOME], { encoding: 'utf8' });
  const freeGb = +(df.stdout.trim().split('\n').pop()?.trim() || 0);
  return { ok: availKb >= 4 * 1024 * 1024 && freeGb >= 25, availGb: +(availKb / 1024 / 1024).toFixed(1), freeGb };
}

function waitForResources() {
  for (let i = 0; i < 60; i++) {
    const r = resourcesOk();
    if (r.ok) return r;
    if (i === 0) console.log(`LOWRES wait (mem ${r.availGb}GB / disk ${r.freeGb}GB)`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
  throw new Error('resources below limits for 30 minutes; aborting');
}

function servingModel(sessionId) {
  if (!sessionId || !existsSync(OC_DB)) return null;
  const p = spawnSync('sqlite3', [OC_DB, `select data from message where session_id='${sessionId}'`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (p.status !== 0) return null;
  for (const line of p.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.role === 'assistant') return { modelID: d.modelID, providerID: d.providerID };
    } catch { /* skip */ }
  }
  return null;
}

function opencodeConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenCode Go',
        options: {
          baseURL: 'https://opencode.ai/inference/go/openai/v1',
          apiKey: '{env:OPENCODE_GO_KEY}',
          headers: { 'x-opencode-session': '{env:OPENCODE_GO_SESSION}' },
        },
        models: {
          'glm-5.3': { name: 'GLM 5.3' },
          'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash' },
        },
      },
    },
  };
}

function parseEvents(stdout) {
  const ev = { tools: {}, toolCalls: 0, steps: 0, texts: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }, cost: 0, error: null, sessionId: null };
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.sessionID) ev.sessionId = j.sessionID;
    if (j.type === 'error') { ev.error = j.error?.data?.message || j.error?.message || 'error'; continue; }
    const part = j.part;
    if (!part) continue;
    if (part.type === 'tool') {
      ev.tools[part.tool] = (ev.tools[part.tool] || 0) + 1;
      ev.toolCalls++;
    } else if (part.type === 'step-start') {
      ev.steps++;
    } else if (part.type === 'text' && part.text) {
      ev.texts.push(part.text);
    } else if (part.type === 'step-finish' && part.tokens) {
      const t = part.tokens;
      ev.tokens.input += t.input || 0;
      ev.tokens.output += t.output || 0;
      ev.tokens.cacheRead += t.cache?.read || 0;
      ev.tokens.cacheWrite += t.cache?.write || 0;
      ev.tokens.reasoning += t.reasoning || 0;
      ev.tokens.total += t.total || 0;
      ev.cost += part.cost || 0;
    }
  }
  return ev;
}

// ---------------------------------------------------------------- main
mkdirSync(dirname(opt.out), { recursive: true });
mkdirSync(join(LIB, 'bench/results/issue1/raw'), { recursive: true });
const done = new Set();
if (!opt.force && existsSync(opt.out)) {
  for (const l of readFileSync(opt.out, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); done.add(`${r.exp}|${r.model}|${r.arm}|${r.rep}`); } catch { /* keep going */ }
  }
}

let cells = 0, skipped = 0;
const t0all = Date.now();
for (let rep = 0; rep < opt.reps; rep++) {
  for (let ei = 0; ei < opt.exps.length; ei++) {
    const expId = opt.exps[ei];
    const E = EXPS[expId];
    for (let mi = 0; mi < opt.models.length; mi++) {
      const model = opt.models[mi];
      const armOrder = ((rep + ei + mi) % 2 === 0) ? opt.arms : [...opt.arms].reverse();
      for (const arm of armOrder) {
        if (done.has(`${expId}|${model}|${arm}|${rep}`)) { skipped++; continue; }
        waitForResources();
        cells++;
        const scratch = join(opt.scratch, `${expId}__${model}__${arm}_r${rep}`);
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true });
        spawnSync('cp', ['-a', join(FIXTURES, E.fixture) + '/.', scratch]);
        if (existsSync(join(scratch, 'setup.sh'))) {
          const s = spawnSync('bash', ['setup.sh'], { cwd: scratch, encoding: 'utf8', timeout: 120 });
          if (s.status !== 0) throw new Error(`setup.sh failed for ${expId}: ${s.stderr}`);
          rmSync(join(scratch, 'setup.sh'));
        }
        writeFileSync(join(scratch, 'opencode.json'), JSON.stringify(opencodeConfig(), null, 2));

        const prompt = E.q + (arm === 'TOOL' ? '\n' + E.hint : '') + TAIL;
        const env = {
          ...process.env,
          // opencode resolves its project directory from $PWD when present;
          // without this the child would inherit the runner's cwd as project.
          PWD: scratch,
          PATH: `${BIN}:${PROTO}:${process.env.PATH}`,
          OPENCODE_GO_KEY: process.env.OPENCODE_GO_KEY,
          OPENCODE_GO_SESSION: `issue1-${expId}-${arm}-r${rep}`.replace(/[^a-z0-9-]/gi, ''),
        };
        const before = hashTree(scratch);
        const t0 = Date.now();
        const p = spawnSync('opencode', ['run', '--pure', '-m', `opencode-go/${model}`, '--format', 'json', '--auto', prompt],
          { cwd: scratch, encoding: 'utf8', timeout: opt.timeout * 1000, maxBuffer: 1 << 26, env });
        const ms = Date.now() - t0;
        const after = hashTree(scratch);

        const ev = parseEvents(p.stdout || '');
        const response = ev.texts.join('\n');
        const answer = (response.match(/ANSWER:\s*([\s\S]+)/i)?.[1] || '').split('\n')[0].trim();
        const factual = E.check(response);
        const strict = !!answer && E.check(answer);
        const sm = servingModel(ev.sessionId);
        const rec = {
          study: 'issue1-v1', exp: expId, model, arm, rep,
          status: p.error ? 'SPAWN_ERROR' : (p.signal ? `SIG${p.signal}` : 'OK'),
          ms, promptBytes: Buffer.byteLength(prompt),
          hintBytes: arm === 'TOOL' ? Buffer.byteLength(E.hint) : 0,
          response, answer: answer.slice(0, 200), strict, factual,
          tools: ev.tools, toolCalls: ev.toolCalls, steps: ev.steps,
          tokens: ev.tokens, cost: +ev.cost.toFixed(6),
          servingModel: sm, sessionId: ev.sessionId, error: ev.error,
          fixtureModified: !sameTree(before, after),
          scratchRelFiles: Object.keys(after).length,
        };
        appendFileSync(opt.out, JSON.stringify(rec) + '\n');
        const rawBase = join(LIB, 'bench/results/issue1/raw', `${expId}__${model}__${arm}_r${rep}`);
        writeFileSync(rawBase + '.stdout.log', (p.stdout || '') + (p.stderr ? `\n[stderr]\n${p.stderr}` : ''));
        rmSync(scratch, { recursive: true, force: true });
        console.log(`RUN ${expId} ${model} ${arm} r${rep} strict=${strict} fact=${factual} tok=${ev.tokens.total} tools=${ev.toolCalls} ms=${ms}${rec.fixtureModified ? ' MODIFIED!' : ''}${ev.error ? ' ERR:' + ev.error.slice(0, 80) : ''}`);
      }
    }
  }
}
console.log(`ISSUE1_DONE cells=${cells} skipped=${skipped} elapsedMs=${Date.now() - t0all}`);
