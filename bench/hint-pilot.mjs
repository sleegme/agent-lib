import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BM25_PARAMS,
  CATALOG,
  COMMAND_ORDER,
  CTX_FALLBACK,
  MAX_SPECIALTY,
  QUESTIONS,
  RULES,
  STOPWORDS,
  TOKENIZER_RULE,
  calculateTokens,
  renderHints,
  scoreResponse,
  selectBm25,
  selectHints,
} from './hints.mjs';

const HOME = process.env.HOME || '';
const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(LIB, 'bin');

export function hashFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function hashDir(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return {};
  try {
    const entries = readdirSync(dirPath, { recursive: true, withFileTypes: true });
    const hashes = {};
    for (const entry of entries) {
      if (entry.isFile()) {
        const full = join(entry.parentPath || dirPath, entry.name);
        const rel = relative(dirPath, full);
        hashes[rel] = hashFile(full);
      }
    }
    return hashes;
  } catch {
    return {};
  }
}

export const toolCounts = (id, homeDir = HOME) => {
  if (!id) return null;
  const p = join(homeDir, '.gemini/antigravity-cli/brain', id, '.system_generated/logs/transcript.jsonl');
  if (!existsSync(p)) return null;
  const c = {};
  try {
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
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
  } catch {
    return null;
  }
};

export function parseArgs(args) {
  const options = {
    dryRun: false,
    out: null,
    agy: process.env.AGY_PATH || join(HOME, '.local/bin/agy'),
    bench: process.env.BENCH || join(HOME, 'work/agent-lib-bench'),
    model: process.env.MODEL || 'gemini-3.8-flash-medium',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--out') {
      options.out = args[++i];
    } else if (arg === '--agy') {
      options.agy = args[++i];
    } else if (arg === '--bench') {
      options.bench = args[++i];
    } else if (arg === '--model') {
      options.model = args[++i];
    } else if (arg === '--help') {
      console.log('Usage: node bench/hint-pilot.mjs [--dry-run] [--out PATH] [--agy PATH] [--bench PATH] [--model MODEL]');
      process.exit(0);
    }
  }

  return options;
}

export function buildMatrix(binDir = BIN) {
  const TASKS = [
    { id: 'F1', text: QUESTIONS.F1 },
    { id: 'F2', text: QUESTIONS.F2 },
  ];
  const MODES = ['all', 'rules', 'bm25'];
  const tail = '\nDo not modify any files. End your reply with a final line: ANSWER: <answer>';
  const matrix = [];

  for (let r = 0; r < 3; r++) {
    for (let t = 0; t < TASKS.length; t++) {
      const task = TASKS[t];
      const k = (r + t) % MODES.length;
      const rotatedModes = MODES.slice(k).concat(MODES.slice(0, k));
      for (const mode of rotatedModes) {
        const selected = selectHints(mode, task.text);
        const bm25Res = selectBm25(task.text);
        const hintsText = renderHints(selected, binDir);
        const prompt = task.text + hintsText + tail;
        matrix.push({
          rep: r,
          id: task.id,
          taskIndex: t,
          mode,
          selected,
          scores: bm25Res.scores,
          prompt,
          promptBytes: Buffer.byteLength(prompt, 'utf8'),
          hints: hintsText,
          hintBytes: Buffer.byteLength(hintsText, 'utf8'),
        });
      }
    }
  }
  return matrix;
}

export function probeAgyVersion(agyPath) {
  if (!agyPath || !existsSync(agyPath)) return null;
  try {
    const p = spawnSync(agyPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (p.status === 0 && p.stdout) return p.stdout.trim();
  } catch {
    // fall through to null
  }
  return null;
}

export function buildManifest(options, matrix, agyVersion = null) {
  const selfPath = fileURLToPath(import.meta.url);
  const hintsPath = new URL('hints.mjs', import.meta.url).pathname;
  const protocolPath = new URL('HINT-PILOT.md', import.meta.url).pathname;

  const plainDir = join(options.bench, 'plain');

  return {
    protocol: 'Selective-hint pilot v1 (predeclared 2026-10-27)',
    catalog: CATALOG,
    settings: {
      model: options.model,
      agyPath: options.agy,
      benchDir: options.bench,
      cwd: plainDir,
      outPath: options.out,
      modes: ['all', 'rules', 'bm25'],
      repetitions: 3,
      selector: {
        catalogOrder: COMMAND_ORDER,
        rules: RULES,
        maxSpecialty: MAX_SPECIALTY,
        ctxFallback: CTX_FALLBACK,
        bm25: {
          k1: BM25_PARAMS.k1,
          b: BM25_PARAMS.b,
          minScore: BM25_PARAMS.minScore,
          relativeMinScore: BM25_PARAMS.relativeMinScore,
          maxSelected: BM25_PARAMS.maxSelected,
          tieEpsilon: BM25_PARAMS.tieEpsilon,
          idfFormula: BM25_PARAMS.idfFormula,
          stopwords: [...STOPWORDS],
          tokenizer: TOKENIZER_RULE,
        },
      },
      process: { timeoutMs: 300000, maxBufferBytes: 1 << 24 },
    },
    questions: QUESTIONS,
    matrix,
    hashes: {
      pilot: hashFile(selfPath),
      hints: hashFile(hintsPath),
      protocol: hashFile(protocolPath),
      plainFixtures: hashDir(plainDir),
    },
    agyVersion,
    requestedModel: options.model,
  };
}

export function runPilot(options) {
  const matrix = buildMatrix(BIN);

  // Dry-run must not execute anything: no version probe, no agy spawn.
  if (options.dryRun) {
    const manifest = buildManifest(options, matrix, null);
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(0);
  }

  const agyVersion = probeAgyVersion(options.agy);
  const manifest = buildManifest(options, matrix, agyVersion);

  if (!options.out) {
    console.error('Error: --out PATH is required when not in --dry-run mode');
    process.exit(2);
  }

  if (existsSync(options.out)) {
    const st = statSync(options.out);
    if (st.size > 0) {
      console.error(`Error: Refusing nonempty output file: ${options.out} (size: ${st.size} bytes)`);
      process.exit(1);
    }
  }

  const manifestPath = options.out.endsWith('.jsonl')
    ? options.out.slice(0, -6) + '.manifest.json'
    : options.out + '.manifest.json';

  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const rawDir = options.out.replace(/(\.jsonl)?$/, '.raw');
  mkdirSync(rawDir, { recursive: true });

  const cwd = join(options.bench, 'plain');
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
  }

  for (const entry of matrix) {
    const { rep, id, mode, selected, prompt, promptBytes, hintBytes } = entry;

    const t0 = Date.now();
    const p = spawnSync(
      options.agy,
      ['-p', prompt, '--model', options.model, '--output-format', 'json', '--dangerously-skip-permissions'],
      { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 24 }
    );
    const elapsedMs = Date.now() - t0;

    const rawBase = `r${rep}_${id}_${mode}`;
    writeFileSync(join(rawDir, `${rawBase}.stdout.log`), p.stdout || '', 'utf8');
    writeFileSync(join(rawDir, `${rawBase}.stderr.log`), p.stderr || '', 'utf8');

    // Normalize the external JSON-envelope boundary: a missing, unparsable, or
    // non-object envelope is a recorded failure status, never a crash and never
    // a silent success.
    const lastLine = (p.stdout || '').trim().split('\n').pop() || '';
    let envelope = null;
    let parsedKind = 'empty';
    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          envelope = parsed;
          parsedKind = 'object';
        } else {
          parsedKind = 'not-object';
        }
      } catch {
        parsedKind = 'parse-fail';
      }
    }

    let status;
    if (p.error) {
      status = 'SPAWN_ERROR';
    } else if (parsedKind === 'empty') {
      status = 'EMPTY_STDOUT';
    } else if (parsedKind === 'parse-fail') {
      status = 'PARSE_FAIL';
    } else if (parsedKind === 'not-object') {
      status = 'ENVELOPE_NOT_OBJECT';
    } else if (typeof envelope.status === 'string' && envelope.status.length > 0) {
      status = envelope.status;
    } else {
      status = 'MISSING_STATUS';
    }

    const actualModel =
      envelope && typeof envelope.model === 'string' && envelope.model ? envelope.model : 'unknown';
    const response = envelope && typeof envelope.response === 'string' ? envelope.response : '';
    const usage = envelope && envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : null;
    const tokens = calculateTokens(usage);
    const scored = scoreResponse(id, response, {
      exitCode: p.status,
      signal: p.signal || null,
      error: p.error ? p.error.message : null,
      status,
    });
    const tools = toolCounts(envelope ? envelope.conversation_id : undefined);

    const rec = {
      rep,
      id,
      mode,
      study: 'hints-pilot-v1',
      exitCode: p.status,
      signal: p.signal || null,
      error: p.error ? p.error.message : null,
      status,
      model: options.model,
      actualModel,
      conv: envelope ? envelope.conversation_id || null : null,
      ans: scored.answer.slice(0, 120),
      response,
      factualCorrect: scored.factualCorrect,
      correct: scored.strictCorrect,
      strictCorrect: scored.strictCorrect,
      finalLineCompliant: scored.finalLineCompliant,
      usage,
      tokens,
      tools,
      selected,
      scores: entry.scores,
      promptBytes,
      hintBytes,
      ms: elapsedMs,
    };

    appendFileSync(options.out, JSON.stringify(rec) + '\n');
    console.log('RUN', id, mode, rep, rec.strictCorrect, rec.factualCorrect, rec.tokens, `${elapsedMs}ms`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2));
  runPilot(options);
}
