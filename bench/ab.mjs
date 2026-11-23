// 4-arm A/B on agy: A=baseline, R=rtk hook only, T=agent-lib hint only, RT=both.
// Usage: ARMS=A,R,T,RT REPS=4 IDS=F1,G1 OUTF=results.jsonl node bench/ab.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.HOME, AGY = HOME + '/.local/bin/agy';
const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = LIB + '/bin';
const BENCH = process.env.BENCH || HOME + '/work/agent-lib-bench';
const MODEL = process.env.MODEL || 'gemini-3.8-flash-medium';
const OUT = process.env.OUTF || BENCH + '/results.jsonl';

const toolCounts = id => {
  const p = HOME + '/.gemini/antigravity-cli/brain/' + id + '/.system_generated/logs/transcript.jsonl';
  if (!id || !existsSync(p)) return null;
  const c = {};
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.type !== 'PLANNER_RESPONSE') continue;
    for (const t of r.tool_calls || []) {
      let k = t.name;
      if (k === 'run_command') {
        const cl = JSON.stringify(t.args || {});
        const m = cl.match(/agent-lib\/bin\/(ctx|git-snap|log-triage|logscan|gate-preflight)\b/) || cl.match(/(?:^|[\s"])(rtk)\s/);
        if (m) k = 'tool:' + m[1];
      }
      c[k] = (c[k] || 0) + 1;
    }
  }
  return c;
};
const has = (...xs) => a => xs.every(x => a.toLowerCase().includes(String(x).toLowerCase()));

const T = [
  ['F1', "What number does plan_budget in src/a.py return when given this repo's config.toml? Follow the code and the files it reads.", has('8750')],
  ['F2', 'Do the version in package.json and the VERSION file match? Answer yes or no and give both versions.', has('no', '2.4.1', '2.4.0')],
  ['F3', 'Which files under src/ import the json module? Give the file names.', a => /b\.py/.test(a) && !/a\.py|c\.py/.test(a)],
  ['G1', 'Which git branch is checked out here, and how many commits is it ahead of origin/main?', has('feature/limits', '2')],
  ['G2', 'How many tracked files have uncommitted modifications, and what is the subject line of the latest commit?', has('1', 'chore: touch env')],
  ['L1', 'In logs/, find the most recently modified .log file. How many lines in it contain ERROR?', has('467')],
  ['L2', 'In logs/events.jsonl, which value of the "type" field is most common, and how many times does it occur?', has('tool_call', '1522')],
  ['X1', 'Reply with the word PONG.', has('pong')],
];
const tail = '\nDo not modify any files. End your reply with a final line: ANSWER: <answer>';
const hint = '\nHelpful commands you can run with your command tool (each does in ONE call what usually takes several):\n' +
  `- ${BIN}/ctx <file>...  show several files with line numbers at once\n` +
  `- ${BIN}/git-snap  branch, ahead/behind, status, recent commits at once\n` +
  `- ${BIN}/gate-preflight  every declared version (VERSION, package.json, ...) with MATCH/MISMATCH, plus git state\n` +
  `- ${BIN}/log-triage <dir-or-glob> [--grep RE] [--fields key]  newest log summary, grep count, JSONL field counts\n` +
  `- ${BIN}/logscan <file|dir|glob> [--where k=v] [--count key] [--fields a,b] [--grep RE]  filter/count/extract JSONL in one call`;

const arms = (process.env.ARMS || 'A,R,T,RT').split(',');
const reps = +(process.env.REPS || 4);
const ids = process.env.IDS ? process.env.IDS.split(',') : null;
if (arms.some(arm => !['A', 'R', 'T', 'RT'].includes(arm))) throw new Error('Unknown arm');
if (!Number.isSafeInteger(reps) || reps < 1) throw new Error('REPS must be a positive integer');
if (ids?.some(id => !T.some(task => task[0] === id))) throw new Error('Unknown task ID');

for (let r = 0; r < reps; r++) for (const [id, q, chk] of T.filter(t => !ids || ids.includes(t[0]))) for (const arm of arms) {
  const cwd = BENCH + (arm.startsWith('R') ? '/rtk' : '/plain');
  const prompt = q + (arm.includes('T') ? hint : '') + tail;
  const t0 = Date.now();
  const p = spawnSync(AGY, ['-p', prompt, '--model', MODEL, '--output-format', 'json', '--dangerously-skip-permissions'],
    { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 24 });
  let j = {}; try { j = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { j = { status: 'PARSE_FAIL' }; }
  const ans = ((j.response || '').match(/ANSWER:\s*(.+)/i) || [])[1] || '';
  const u = j.usage || {};
  const rec = { rep: r, id, arm, correct: !!ans && chk(ans),
    factualCorrect: !!ans && chk(id === 'F2' ? j.response || '' : ans),
    study: 'main',
    ans: ans.slice(0, 120), response: j.response || '', status: j.status, usage: j.usage,
    tokens: (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.output_tokens || 0),
    tools: toolCounts(j.conversation_id), conv: j.conversation_id, ms: Date.now() - t0 };
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log('RUN', id, arm, r, rec.correct, rec.tokens);
}
console.log('AB_DONE');
