// Usage: node bench/summarize.mjs results.jsonl [--json]
import { readFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2], 'utf8').split('\n')
  .filter(line => line.trim()).map(line => JSON.parse(line));
if (!rows.length) throw new Error('No measurements');
const keys = rows.map(row => `${row.id}:${row.arm}:${row.rep}`);
if (new Set(keys).size !== keys.length) throw new Error('Duplicate task/arm/repetition');
if (new Set(rows.map(row => row.study || 'main')).size !== 1) {
  throw new Error('Summarize separate studies separately');
}
const arms = ['A', 'R', 'T', 'RT'].filter(arm => rows.some(row => row.arm === arm));
if (rows.some(row => !arms.includes(row.arm))) throw new Error('Unknown arm');
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const usageKeys = ['input_tokens', 'cache_read_tokens', 'output_tokens'];
const knownUsage = row => usageKeys.every(key =>
  Number.isFinite(row.usage?.[key]) && row.usage[key] >= 0);
for (const row of rows.filter(knownUsage)) {
  if (row.tokens !== usageKeys.reduce((sum, key) => sum + row.usage[key], 0)) {
    throw new Error(`Token mismatch: ${row.id}/${row.arm}/${row.rep}`);
  }
}
const stat = group => {
  const measured = group.filter(knownUsage);
  const withTools = group.filter(row => row.tools !== null && typeof row.tools === 'object');
  return {
    attempts: group.length,
    failures: group.filter(row => row.status !== 'SUCCESS').length,
    strictPasses: group.filter(row => row.status === 'SUCCESS' && row.correct).length,
    factualScored: group.filter(row => typeof row.factualCorrect === 'boolean').length,
    factualPasses: group.filter(row => row.status === 'SUCCESS' && row.factualCorrect === true).length,
    usageMeasured: measured.length,
    inputTokens: measured.reduce((sum, row) => sum + row.usage.input_tokens, 0),
    cacheReadTokens: measured.reduce((sum, row) => sum + row.usage.cache_read_tokens, 0),
    outputTokens: measured.reduce((sum, row) => sum + row.usage.output_tokens, 0),
    totalTokens: measured.reduce((sum, row) => sum + row.tokens, 0),
    medianTokens: median(measured.map(row => row.tokens)),
    meanTokens: mean(measured.map(row => row.tokens)),
    toolsMeasured: withTools.length,
    meanToolCalls: mean(withTools.map(row =>
      Object.values(row.tools).reduce((sum, count) => sum + count, 0))),
  };
};
const result = {
  study: rows[0].study || 'main',
  runs: rows.length,
  arms: Object.fromEntries(arms.map(arm => [arm, stat(rows.filter(row => row.arm === arm))])),
  tasks: Object.fromEntries([...new Set(rows.map(row => row.id))].map(id => [
    id, Object.fromEntries(arms.map(arm => [
      arm, stat(rows.filter(row => row.id === id && row.arm === arm)),
    ])),
  ])),
  bundledCalls: {},
};
for (const row of rows) {
  for (const [tool, count] of Object.entries(row.tools || {})) {
    // Old runs misclassified fixture paths containing /rtk/ as actual RTK calls.
    if (tool.startsWith('tool:') && tool !== 'tool:rtk') {
      const key = `${row.arm} ${tool}`;
      result.bundledCalls[key] = (result.bundledCalls[key] || 0) + count;
    }
  }
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const k = value => value === null ? '-' : `${(value / 1000).toFixed(1)}k`;
  const factual = group => group.factualScored === group.attempts
    ? `${group.factualPasses}/${group.attempts}` : `unscored (${group.factualScored}/${group.attempts})`;
  console.log('## per arm (all attempted runs; failures are not discarded)');
  console.log('| arm | factual correct | strict final-line passes | median tokens | mean tokens | tool calls/run |');
  console.log('|---|---:|---:|---:|---:|---:|');
  const baseline = result.arms.A?.meanTokens;
  for (const [arm, group] of Object.entries(result.arms)) {
    const delta = arm !== 'A' && baseline && group.meanTokens !== null
      ? ` (${((group.meanTokens / baseline - 1) * 100).toFixed(1)}%)` : '';
    console.log(`| ${arm} | ${factual(group)} | ${group.strictPasses}/${group.attempts} | ${k(group.medianTokens)} | ${k(group.meanTokens)}${delta} | ${group.meanToolCalls?.toFixed(2) ?? '-'} |`);
    if (group.usageMeasured !== group.attempts || group.toolsMeasured !== group.attempts) {
      console.log(`Missing measurements for ${arm}: usage ${group.usageMeasured}/${group.attempts}, tools ${group.toolsMeasured}/${group.attempts}`);
    }
  }
  console.log('\n## per task: factual correct, median tokens');
  console.log(`| task | ${arms.join(' | ')} |`);
  console.log(`|---|${arms.map(() => '---:').join('|')}|`);
  for (const [id, groups] of Object.entries(result.tasks)) {
    console.log(`| ${id} | ${arms.map(arm => `${factual(groups[arm])} ${k(groups[arm].medianTokens)}`).join(' | ')} |`);
  }
  console.log('\n## bundled tool calls by arm');
  for (const [key, count] of Object.entries(result.bundledCalls).sort()) {
    console.log(`- ${key}: ${count}`);
  }
}
