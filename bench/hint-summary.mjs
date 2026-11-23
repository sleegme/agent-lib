import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const usageKeys = ['input_tokens', 'cache_read_tokens', 'output_tokens'];

export const knownUsage = row =>
  row.usage &&
  typeof row.usage === 'object' &&
  usageKeys.every(k => typeof row.usage[k] === 'number' && Number.isFinite(row.usage[k]) && row.usage[k] >= 0);

// A failed attempt is one with an observed process failure (nonzero exit,
// signal, or spawn error) or a non-SUCCESS envelope status. The process
// outcome is checked alongside the status so a SUCCESS envelope produced by
// a failed process can never count as a pass or enter a cost pair.
export const processFailureReason = row => {
  if (typeof row.exitCode === 'number' && row.exitCode !== 0) return `exit_code_${row.exitCode}`;
  if (row.signal !== null && row.signal !== undefined && row.signal !== '') return `signal_${row.signal}`;
  if (row.error !== null && row.error !== undefined && row.error !== '') return 'process_error';
  return null;
};

export const attemptFailed = row => row.status !== 'SUCCESS' || processFailureReason(row) !== null;

const pairExclusionReasons = (row, label) => {
  const reasons = [];
  const proc = processFailureReason(row);
  if (proc) reasons.push(`${label}:${proc}`);
  if (row.status !== 'SUCCESS') {
    reasons.push(`${label}:status=${typeof row.status === 'string' ? row.status : 'missing'}`);
  }
  if (!knownUsage(row)) reasons.push(`${label}:usage_missing`);
  return reasons;
};

export const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export const stat = group => {
  const measured = group.filter(knownUsage);
  const withElapsed = group.filter(r => typeof r.ms === 'number' && Number.isFinite(r.ms));
  const elapsedValues = withElapsed.map(r => r.ms);
  const withPromptBytes = group.filter(r => typeof r.promptBytes === 'number' && Number.isFinite(r.promptBytes));
  const withHintBytes = group.filter(r => typeof r.hintBytes === 'number' && Number.isFinite(r.hintBytes));
  const toolsMeasuredRows = group.filter(r => r.tools && typeof r.tools === 'object');
  const modelKnownRows = group.filter(r => typeof r.actualModel === 'string' && r.actualModel && r.actualModel !== 'unknown');
  return {
    attempts: group.length,
    failures: group.filter(attemptFailed).length,
    strictPasses: group.filter(r => !attemptFailed(r) && (r.strictCorrect === true || r.correct === true)).length,
    factualPasses: group.filter(r => !attemptFailed(r) && r.factualCorrect === true).length,
    usageMeasured: measured.length,
    inputTokens: measured.reduce((sum, r) => sum + r.usage.input_tokens, 0),
    cacheReadTokens: measured.reduce((sum, r) => sum + r.usage.cache_read_tokens, 0),
    outputTokens: measured.reduce((sum, r) => sum + r.usage.output_tokens, 0),
    totalTokens: measured.reduce((sum, r) => sum + r.tokens, 0),
    medianTokens: median(measured.map(r => r.tokens)),
    meanTokens: mean(measured.map(r => r.tokens)),
    elapsedMs: mean(elapsedValues),
    totalElapsedMs: elapsedValues.reduce((sum, v) => sum + v, 0),
    medianElapsedMs: median(elapsedValues),
    promptBytesMeasured: withPromptBytes.length,
    totalPromptBytes: withPromptBytes.reduce((sum, r) => sum + r.promptBytes, 0),
    meanPromptBytes: mean(withPromptBytes.map(r => r.promptBytes)),
    hintBytesMeasured: withHintBytes.length,
    totalHintBytes: withHintBytes.reduce((sum, r) => sum + r.hintBytes, 0),
    meanHintBytes: mean(withHintBytes.map(r => r.hintBytes)),
    toolsMeasured: toolsMeasuredRows.length,
    toolsNull: group.length - toolsMeasuredRows.length,
    modelKnown: modelKnownRows.length,
    modelUnknown: group.length - modelKnownRows.length,
  };
};

export function computePairs(rows) {
  const comparators = ['rules', 'bm25'];
  const tasks = ['F1', 'F2'];
  const reps = [0, 1, 2];
  const results = {};

  for (const cmp of comparators) {
    const pairs = [];
    const excluded = [];
    const missing = [];

    for (const taskId of tasks) {
      for (const rep of reps) {
        const rowAll = rows.find(r => r.id === taskId && r.rep === rep && (r.mode === 'all' || r.arm === 'all'));
        const rowCmp = rows.find(r => r.id === taskId && r.rep === rep && (r.mode === cmp || r.arm === cmp));

        if (!rowAll || !rowCmp) {
          missing.push({ id: taskId, rep, missingAll: !rowAll, missingCmp: !rowCmp });
          continue;
        }

        const allReasons = pairExclusionReasons(rowAll, 'all');
        const cmpReasons = pairExclusionReasons(rowCmp, cmp);

        if (allReasons.length > 0 || cmpReasons.length > 0) {
          excluded.push({
            id: taskId,
            rep,
            reasons: [...allReasons, ...cmpReasons],
            allStatus: rowAll.status ?? null,
            allExitCode: typeof rowAll.exitCode === 'number' ? rowAll.exitCode : null,
            allUsageKnown: knownUsage(rowAll),
            allTokens: knownUsage(rowAll) ? rowAll.tokens : null,
            cmpStatus: rowCmp.status ?? null,
            cmpExitCode: typeof rowCmp.exitCode === 'number' ? rowCmp.exitCode : null,
            cmpUsageKnown: knownUsage(rowCmp),
            cmpTokens: knownUsage(rowCmp) ? rowCmp.tokens : null,
          });
          continue;
        }

        const deltaTokens = rowCmp.tokens - rowAll.tokens;
        const percentDelta = rowAll.tokens > 0 ? ((rowCmp.tokens - rowAll.tokens) / rowAll.tokens) * 100 : 0;
        pairs.push({
          id: taskId,
          rep,
          allTokens: rowAll.tokens,
          cmpTokens: rowCmp.tokens,
          deltaTokens,
          percentDelta,
        });
      }
    }

    const deltas = pairs.map(p => p.deltaTokens);
    const pcts = pairs.map(p => p.percentDelta);
    const excludedReasonCounts = {};
    for (const e of excluded) {
      for (const reason of e.reasons) {
        excludedReasonCounts[reason] = (excludedReasonCounts[reason] || 0) + 1;
      }
    }
    results[cmp] = {
      comparator: cmp,
      totalExpected: tasks.length * reps.length, // 6
      validPairs: pairs.length,
      excludedCount: excluded.length,
      missingCount: missing.length,
      meanDeltaTokens: mean(deltas),
      medianDeltaTokens: median(deltas),
      meanPercentDelta: mean(pcts),
      excludedReasonCounts,
      pairs,
      excluded,
      missing,
    };
  }
  return results;
}

export function summarizeResults(rows) {
  if (!rows || !rows.length) throw new Error('No measurements');

  const keys = rows.map(r => `${r.id}:${r.mode || r.arm}:${r.rep}`);
  if (new Set(keys).size !== keys.length) {
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    throw new Error(`Duplicate cell: ${dup}`);
  }

  const allowedModes = ['all', 'rules', 'bm25'];
  for (const r of rows) {
    const m = r.mode || r.arm;
    if (!allowedModes.includes(m)) {
      throw new Error(`Unknown mode: ${m}`);
    }
  }

  const studies = new Set(rows.map(r => r.study || 'main'));
  if (studies.size > 1) {
    throw new Error('Summarize separate studies separately');
  }

  for (const r of rows) {
    if (knownUsage(r)) {
      const exp = r.usage.input_tokens + r.usage.cache_read_tokens + r.usage.output_tokens;
      if (r.tokens !== exp) {
        throw new Error(`Token mismatch: ${r.id}/${r.mode || r.arm}/${r.rep}`);
      }
    } else if (typeof r.tokens === 'number') {
      throw new Error(`Token mismatch: ${r.id}/${r.mode || r.arm}/${r.rep}`);
    }
  }

  const modes = ['all', 'rules', 'bm25'].filter(m => rows.some(r => (r.mode || r.arm) === m));
  const tasks = [...new Set(rows.map(r => r.id))].sort();

  const modeStats = Object.fromEntries(
    modes.map(m => [m, stat(rows.filter(r => (r.mode || r.arm) === m))])
  );

  const taskStats = Object.fromEntries(
    tasks.map(id => [
      id,
      Object.fromEntries(
        modes.map(m => [m, stat(rows.filter(r => r.id === id && (r.mode || r.arm) === m))])
      ),
    ])
  );

  const pairs = computePairs(rows);

  const toolsMeasuredRows = rows.filter(r => r.tools && typeof r.tools === 'object');
  const modelKnownRows = rows.filter(r => typeof r.actualModel === 'string' && r.actualModel && r.actualModel !== 'unknown');
  const usageMeasuredRows = rows.filter(knownUsage);

  return {
    study: rows[0].study || 'main',
    runs: rows.length,
    modes: modeStats,
    tasks: taskStats,
    pairs,
    coverage: {
      attempts: rows.length,
      usage: { measured: usageMeasuredRows.length, unknown: rows.length - usageMeasuredRows.length },
      tools: { measured: toolsMeasuredRows.length, null: rows.length - toolsMeasuredRows.length },
      actualModel: { known: modelKnownRows.length, unknown: rows.length - modelKnownRows.length },
      contamination: {
        evidenceRecorded: 'none',
        disclosure:
          'No fixture/plugin contamination observation is embedded in this analyzer and the attempt records carry no contamination evidence; compare the manifest fixture hashes against pre-pilot hashes before claiming contamination or its absence.',
      },
    },
  };
}

const k = val => (val === null || val === undefined ? '-' : `${(val / 1000).toFixed(1)}k`);
const pct = val => (val === null || val === undefined ? '-' : `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`);

export function formatMarkdown(summary) {
  let md = '';
  md += '## Per mode (all attempted runs; failures are not discarded)\n';
  md += '| mode | factual correct | strict passes | failures | median tokens | mean tokens | mean prompt bytes | mean hint bytes | elapsed ms |\n';
  md += '|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const [mode, s] of Object.entries(summary.modes)) {
    const elapsed = s.elapsedMs !== null ? `${Math.round(s.elapsedMs)}ms` : '-';
    const meanPrompt = s.meanPromptBytes !== null && s.meanPromptBytes !== undefined ? Math.round(s.meanPromptBytes) : '-';
    const meanHint = s.meanHintBytes !== null && s.meanHintBytes !== undefined ? Math.round(s.meanHintBytes) : '-';
    md += `| ${mode} | ${s.factualPasses}/${s.attempts} | ${s.strictPasses}/${s.attempts} | ${s.failures} | ${k(s.medianTokens)} | ${k(s.meanTokens)} | ${meanPrompt} | ${meanHint} | ${elapsed} |\n`;
    if (s.usageMeasured !== s.attempts) {
      md += `Missing usage for ${mode}: ${s.usageMeasured}/${s.attempts}\n`;
    }
    if (s.toolsNull > 0) {
      md += `Tool counts null for ${mode}: ${s.toolsNull}/${s.attempts} (measured ${s.toolsMeasured})\n`;
    }
    if (s.modelUnknown > 0) {
      md += `Actual serving model unknown for ${mode}: ${s.modelUnknown}/${s.attempts} (known ${s.modelKnown})\n`;
    }
  }

  md += '\n## Paired comparisons vs all (matched by task & repetition)\n';
  md += '| comparator | valid pairs | excluded | mean delta tokens | mean % delta |\n';
  md += '|---|---:|---:|---:|---:|\n';
  for (const [cmp, p] of Object.entries(summary.pairs)) {
    md += `| ${cmp} vs all | ${p.validPairs}/${p.totalExpected} | ${p.excludedCount} | ${p.meanDeltaTokens !== null ? Math.round(p.meanDeltaTokens) : '-'} | ${pct(p.meanPercentDelta)} |\n`;
  }

  md += '\n### Pair details\n';
  for (const [cmp, p] of Object.entries(summary.pairs)) {
    for (const pr of p.pairs) {
      md += `- pair ${pr.id}/rep${pr.rep}: all ${pr.allTokens} vs ${cmp} ${pr.cmpTokens} tokens (${pr.deltaTokens >= 0 ? '+' : ''}${pr.deltaTokens}, ${pct(pr.percentDelta)})\n`;
    }
    for (const ex of p.excluded) {
      md += `- excluded ${ex.id}/rep${ex.rep}: ${ex.reasons.join(', ')} (all status ${ex.allStatus ?? 'missing'}, exit ${ex.allExitCode ?? 'n/a'}, tokens ${ex.allTokens ?? 'unknown'}; ${cmp} status ${ex.cmpStatus ?? 'missing'}, exit ${ex.cmpExitCode ?? 'n/a'}, tokens ${ex.cmpTokens ?? 'unknown'})\n`;
    }
    for (const ms of p.missing) {
      md += `- missing ${ms.id}/rep${ms.rep}: ${ms.missingAll ? 'all' : ''}${ms.missingAll && ms.missingCmp ? ' and ' : ''}${ms.missingCmp ? cmp : ''} attempt absent\n`;
    }
  }

  const cov = summary.coverage;
  if (cov) {
    md += '\n## Coverage and contamination\n';
    md += `- usage measured: ${cov.usage.measured}/${cov.attempts} (unknown ${cov.usage.unknown})\n`;
    md += `- tool counts measured: ${cov.tools.measured}/${cov.attempts} (null ${cov.tools.null})\n`;
    md += `- actual serving model known: ${cov.actualModel.known}/${cov.attempts} (unknown ${cov.actualModel.unknown})\n`;
    md += `- contamination: ${cov.contamination.evidenceRecorded} recorded — ${cov.contamination.disclosure}\n`;
  }

  md += '\n## Per task breakdown\n';
  const modes = Object.keys(summary.modes);
  md += `| task | ${modes.map(m => `${m} factual (med tok)`).join(' | ')} |\n`;
  md += `|---|${modes.map(() => '---:').join('|')}|\n`;
  for (const [taskId, byMode] of Object.entries(summary.tasks)) {
    const cols = modes.map(m => {
      const s = byMode[m];
      return `${s.factualPasses}/${s.attempts} (${k(s.medianTokens)})`;
    });
    md += `| ${taskId} | ${cols.join(' | ')} |\n`;
  }

  return md;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('Usage: node bench/hint-summary.mjs <results.jsonl> [--json]');
    process.exit(2);
  }
  const content = readFileSync(file, 'utf8');
  const rows = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const summary = summarizeResults(rows);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatMarkdown(summary));
  }
}
