// Regrade stored issue1 records with the current answer-key checkers
// (issue1-exps.mjs). Runs are immutable artifacts; this recomputes
// strict/factual deterministically from the stored response/answer text.
// Usage: node bench/issue1-regrade.mjs [results.jsonl]
// Prints per-exp changes, keeps the pre-regrade copy at <out>.pregrade.jsonl
// only when something actually changed.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPS } from './issue1-exps.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2]?.endsWith('.jsonl') ? process.argv[2] : join(LIB, 'bench/results/issue1/results.jsonl');
const lines = readFileSync(out, 'utf8').split('\n').filter(l => l.trim());
const recs = lines.map(l => JSON.parse(l));

let changed = 0;
const byExp = {};
for (const r of recs) {
  const E = EXPS[r.exp];
  if (!E) continue;
  // Re-extract the full ANSWER line from the stored response the same way
  // the runner did at run time; the stored `answer` field is a truncated
  // slice and must not be re-scored directly.
  const answer = ((r.response || '').match(/ANSWER:\s*([\s\S]+)/i) || [])[1]?.split('\n')[0]?.trim() || '';
  const strict = !!answer && E.check(answer);
  const factual = E.check(r.response || '');
  if (strict !== r.strict || factual !== r.factual) {
    changed++;
    byExp[r.exp] = byExp[r.exp] || {};
    byExp[r.exp][`${r.strict}/${r.factual}->${strict}/${factual}`] = (byExp[r.exp][`${r.strict}/${r.factual}->${strict}/${factual}`] || 0) + 1;
    r.strict = strict;
    r.factual = factual;
  }
}
if (changed > 0 && !existsSync(out + '.pregrade.jsonl')) {
  copyFileSync(out, out + '.pregrade.jsonl');
}
writeFileSync(out, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`regraded ${changed}/${recs.length} records (${out})`);
for (const [exp, transitions] of Object.entries(byExp)) {
  for (const [t, n] of Object.entries(transitions)) console.log(`  ${exp}: ${t} x${n}`);
}
