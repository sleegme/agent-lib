// Summarize bench/results/issue1/results.jsonl: per (exp, model, arm) stats,
// paired per-rep differences TOOL-BASE, and per-model token totals.
// Usage: node bench/issue1-summarize.mjs [results.jsonl] [--json | --md]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = process.argv[2]?.endsWith('.jsonl') ? process.argv[2] : join(LIB, 'bench/results/issue1/results.jsonl');

const recs = readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; };

const key = r => `${r.exp}|${r.model}|${r.arm}`;
const groups = new Map();
for (const r of recs) {
  if (!groups.has(key(r))) groups.set(key(r), []);
  groups.get(key(r)).push(r);
}

const stats = {};
for (const [k, rs] of groups) {
  const toks = rs.map(r => r.tokens?.total ?? 0);
  stats[k] = {
    n: rs.length,
    strict: rs.filter(r => r.strict).length,
    factual: rs.filter(r => r.factual).length,
    tokMedian: median(toks), tokMean: mean(toks), tokMin: Math.min(...toks), tokMax: Math.max(...toks),
    tokQ1: q(toks, 0.25), tokQ3: q(toks, 0.75),
    inMedian: median(rs.map(r => r.tokens?.input ?? 0)),
    cacheReadMedian: median(rs.map(r => r.tokens?.cacheRead ?? 0)),
    outMedian: median(rs.map(r => r.tokens?.output ?? 0)),
    toolCallsMedian: median(rs.map(r => r.toolCalls ?? 0)),
    stepsMedian: median(rs.map(r => r.steps ?? 0)),
    msMedian: median(rs.map(r => r.ms ?? 0)),
    modified: rs.filter(r => r.fixtureModified).length,
    servingModels: [...new Set(rs.map(r => r.servingModel?.modelID || 'unknown'))],
  };
}

const pairs = {};
for (const r of recs) {
  const pk = `${r.exp}|${r.model}`;
  pairs[pk] = pairs[pk] || {};
  pairs[pk][r.rep] = pairs[pk][r.rep] || {};
  pairs[pk][r.rep][r.arm] = r;
}
const paired = {};
for (const [pk, byRep] of Object.entries(pairs)) {
  const dTok = [], dCalls = [], dMs = [], rows = [];
  for (const [rep, arms] of Object.entries(byRep)) {
    if (!arms.BASE || !arms.TOOL) continue;
    const dt = (arms.TOOL.tokens?.total ?? 0) - (arms.BASE.tokens?.total ?? 0);
    dTok.push(dt); dCalls.push((arms.TOOL.toolCalls ?? 0) - (arms.BASE.toolCalls ?? 0)); dMs.push((arms.TOOL.ms ?? 0) - (arms.BASE.ms ?? 0));
    rows.push({ rep: +rep, baseTok: arms.BASE.tokens?.total, toolTok: arms.TOOL.tokens?.total, dTok: dt });
  }
  paired[pk] = { n: rows.length, dTokMedian: median(dTok), dTokMean: mean(dTok), dTokMin: dTok.length ? Math.min(...dTok) : null, dTokMax: dTok.length ? Math.max(...dTok) : null, dCallsMedian: median(dCalls), dMsMedian: median(dMs), rows };
}

const perModel = {};
for (const r of recs) {
  perModel[r.model] = perModel[r.model] || { runs: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, ms: 0 };
  perModel[r.model].runs++;
  perModel[r.model].tokens += r.tokens?.total ?? 0;
  perModel[r.model].input += r.tokens?.input ?? 0;
  perModel[r.model].output += r.tokens?.output ?? 0;
  perModel[r.model].cacheRead += r.tokens?.cacheRead ?? 0;
  perModel[r.model].ms += r.ms ?? 0;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ stats, paired, perModel, records: recs.length }, null, 2));
} else if (process.argv.includes('--md')) {
  console.log('### Per-experiment medians and paired differences (TOOL vs BASE)\n');
  for (const model of Object.keys(perModel)) {
    console.log(`#### ${model}\n`);
    console.log('| exp | arm | n | strict | factual | tok med (q1-q3) | tok mean | calls | steps | ms med | mod |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const exp of [...new Set(recs.map(r => r.exp))]) {
      for (const arm of ['BASE', 'TOOL']) {
        const s = stats[`${exp}|${model}|${arm}`];
        if (!s) continue;
        console.log(`| ${exp} | ${arm} | ${s.n} | ${s.strict}/${s.n} | ${s.factual}/${s.n} | ${s.tokMedian} (${s.tokQ1}-${s.tokQ3}) | ${Math.round(s.tokMean)} | ${s.toolCallsMedian} | ${s.stepsMedian} | ${s.msMedian} | ${s.modified} |`);
      }
      const p = paired[`${exp}|${model}`];
      const base = stats[`${exp}|${model}|BASE`];
      if (p && base && p.n) {
        const rel = base.tokMedian ? ` (${((p.dTokMedian / base.tokMedian) * 100).toFixed(1)}% of base median)` : '';
        console.log(`| ${exp} | paired dTok | ${p.n} | | | med ${p.dTokMedian}${rel} | min ${p.dTokMin} / max ${p.dTokMax} | dCalls med ${p.dCallsMedian} | | dMs med ${p.dMsMedian} | |`);
      }
    }
    console.log('');
  }
  console.log('### Per-model totals\n');
  console.log('| model | runs | total tokens | input | cache-read | output | total ms |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [m, s] of Object.entries(perModel)) console.log(`| ${m} | ${s.runs} | ${s.tokens} | ${s.input} | ${s.cacheRead} | ${s.output} | ${s.ms} |`);
} else {
  console.log(`records: ${recs.length}  (${path})\n`);
  for (const [k, s] of Object.entries(stats).sort()) {
    console.log(`${k}: n=${s.n} strict=${s.strict}/${s.n} factual=${s.factual}/${s.n} tok med=${s.tokMedian} (q1=${s.tokQ1} q3=${s.tokQ3} min=${s.tokMin} max=${s.tokMax}) in=${s.inMedian} cacheR=${s.cacheReadMedian} out=${s.outMedian} calls=${s.toolCallsMedian} steps=${s.stepsMedian} ms=${s.msMedian} mod=${s.modified} model=${s.servingModels.join(',')}`);
  }
  console.log('');
  for (const [pk, p] of Object.entries(paired).sort()) {
    console.log(`PAIR ${pk}: n=${p.n} dTok med=${p.dTokMedian} mean=${Math.round(p.dTokMean ?? 0)} min=${p.dTokMin} max=${p.dTokMax} dCalls med=${p.dCallsMedian} dMs med=${p.dMsMedian}`);
    for (const r of p.rows) console.log(`   rep${r.rep}: base=${r.baseTok} tool=${r.toolTok} d=${r.dTok}`);
  }
  console.log('');
  for (const [m, s] of Object.entries(perModel)) console.log(`TOTAL ${m}: runs=${s.runs} tokens=${s.tokens} (in=${s.input} out=${s.output} cacheRead=${s.cacheRead}) ms=${s.ms}`);
}
