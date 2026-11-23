import { readFileSync } from 'node:fs';

const abSource = readFileSync(new URL('ab.mjs', import.meta.url), 'utf8');

const extractQuestion = id => {
  const re = new RegExp(`\\['${id}',\\s*["'\`]([\\s\\S]*?)["'\`],`);
  const m = abSource.match(re);
  if (!m) throw new Error(`Could not find question for ${id} in ab.mjs`);
  return m[1];
};

export const QUESTIONS = {
  F1: extractQuestion('F1'),
  F2: extractQuestion('F2'),
};

export const HINT_HEADING = '\nHelpful commands you can run with your command tool (each does in ONE call what usually takes several):\n';

const GENERIC_TERMS = {
  'ctx': 'code source files read inspect function imports configuration config',
  'git-snap': 'git branch ahead behind status tracked modified commits latest subject',
  'gate-preflight': 'compare version versions package release declared match mismatch',
  'log-triage': 'logs newest recent modified error errors summary grep count',
  'logscan': 'jsonl events field fields type filter extract occurrences frequency',
};

export const COMMAND_ORDER = ['ctx', 'git-snap', 'gate-preflight', 'log-triage', 'logscan'];

export const CATALOG = COMMAND_ORDER.map(id => {
  const lineMatch = abSource.match(new RegExp(`-\\s*\\$\\{BIN\\}/${id}([^\`\n\r]+)`));
  if (!lineMatch) throw new Error(`Could not find hint line for ${id} in ab.mjs`);
  const rawSuffix = lineMatch[1].replace(/\\n$/, '');
  return {
    id,
    description: rawSuffix.trim(),
    terms: GENERIC_TERMS[id],
    genericTerms: GENERIC_TERMS[id],
    rawSuffix,
  };
});

export const STOPWORDS = new Set(
  'a an and are as at be by do does for from given how in is it of on or repo s that the this to under what when which with you your'.split(' ')
);

export const TOKENIZER_RULE = 'lowercase input, then ASCII alphanumeric runs [a-z0-9]+ as tokens (punctuation and underscores split); no stemming; query terms deduplicated';

export const BM25_PARAMS = {
  k1: 1.2,
  b: 0.75,
  minScore: 1.0,
  relativeMinScore: 0.5,
  maxSelected: 2,
  tieEpsilon: 1e-9,
  idfFormula: 'log(1 + (N - df + 0.5) / (df + 0.5))',
};

export function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const rawTokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return rawTokens.filter(t => !STOPWORDS.has(t));
}

const N = CATALOG.length; // 5
const DOCS = CATALOG.map(item => ({
  id: item.id,
  tokens: tokenize(`${item.description} ${item.terms}`),
}));
const avgdl = DOCS.reduce((sum, d) => sum + d.tokens.length, 0) / N;

const DF = new Map();
for (const doc of DOCS) {
  const uniqueTerms = new Set(doc.tokens);
  for (const t of uniqueTerms) {
    DF.set(t, (DF.get(t) || 0) + 1);
  }
}

export function idf(term) {
  const df = DF.get(term) || 0;
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

// Selector settings exported for the pre-call manifest; selectRules() is
// derived from this data so the recorded definition is the definition that runs.
export const RULES = [
  {
    id: 'gate-preflight',
    match: { requiresAnyOf: ['version', 'versions'], withAnyOf: ['match', 'compare', 'same', 'mismatch', 'declared', 'release', 'package'] },
  },
  {
    id: 'git-snap',
    match: { anyOf: ['branch', 'ahead', 'behind', 'commit', 'commits', 'tracked', 'uncommitted', 'status'] },
  },
  {
    id: 'logscan',
    match: { anyOf: ['jsonl'] },
    orMatch: { requiresAnyOf: ['field', 'fields'], withAnyOf: ['count', 'common', 'filter', 'extract'] },
  },
  {
    id: 'log-triage',
    match: { requiresAnyOf: ['log', 'logs'], withAnyOf: ['newest', 'recent', 'modified', 'error', 'errors', 'grep'] },
  },
];

export const MAX_SPECIALTY = 2;

export const CTX_FALLBACK = {
  id: 'ctx',
  appliesOnlyWhenNoSpecialtyMatches: true,
  match: { anyOf: ['file', 'files', 'src', 'code', 'config', 'configuration', 'import', 'imports', 'function', 'read'] },
};

const conditionMatches = (condition, tokenSet) =>
  (!condition.requiresAnyOf || condition.requiresAnyOf.some(w => tokenSet.has(w))) &&
  (!condition.withAnyOf || condition.withAnyOf.some(w => tokenSet.has(w))) &&
  (!condition.anyOf || condition.anyOf.some(w => tokenSet.has(w)));

const ruleMatches = (rule, tokenSet) => {
  if (rule.orMatch) {
    return conditionMatches(rule.match, tokenSet) || conditionMatches(rule.orMatch, tokenSet);
  }
  return conditionMatches(rule.match, tokenSet);
};

export function selectRules(queryText) {
  if (!queryText || typeof queryText !== 'string') return [];
  const tokens = queryText.toLowerCase().match(/[a-z0-9]+/g) || [];
  const tokenSet = new Set(tokens);

  const specialty = RULES.filter(rule => ruleMatches(rule, tokenSet)).map(rule => rule.id);
  if (specialty.length > 0) {
    return specialty.slice(0, MAX_SPECIALTY);
  }
  if (conditionMatches(CTX_FALLBACK.match, tokenSet)) {
    return [CTX_FALLBACK.id];
  }
  return [];
}

export function scoreBm25(queryText) {
  const queryTokens = tokenize(queryText);
  const deduplicated = [...new Set(queryTokens)];

  const { k1, b } = BM25_PARAMS;
  const scores = {};

  for (const doc of DOCS) {
    const dl = doc.tokens.length;
    const tfMap = new Map();
    for (const t of doc.tokens) {
      tfMap.set(t, (tfMap.get(t) || 0) + 1);
    }

    let score = 0;
    for (const t of deduplicated) {
      const tf = tfMap.get(t) || 0;
      if (tf > 0) {
        const termIdf = idf(t);
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (dl / avgdl));
        score += termIdf * (numerator / denominator);
      }
    }
    scores[doc.id] = score;
  }
  return scores;
}

export function pickTop(scores) {
  const maxScore = Math.max(...Object.values(scores), 0);
  if (maxScore <= 0) {
    return [];
  }

  const threshold = Math.max(BM25_PARAMS.minScore, BM25_PARAMS.relativeMinScore * maxScore);
  return CATALOG
    .filter(item => scores[item.id] >= threshold)
    .sort((a, b) => {
      const diff = scores[b.id] - scores[a.id];
      if (Math.abs(diff) > BM25_PARAMS.tieEpsilon) return diff;
      return CATALOG.indexOf(a) - CATALOG.indexOf(b);
    })
    .slice(0, BM25_PARAMS.maxSelected)
    .map(c => c.id);
}

export function selectBm25(queryText) {
  const scores = scoreBm25(queryText);
  return { selected: pickTop(scores), scores };
}

export function selectHints(mode, queryText) {
  if (mode === 'all') {
    return CATALOG.map(c => c.id);
  }
  if (mode === 'rules') {
    return selectRules(queryText);
  }
  if (mode === 'bm25') {
    return selectBm25(queryText).selected;
  }
  throw new Error(`Unknown hints selection mode: ${mode}`);
}

export function renderHints(selectedIds, binDir) {
  if (!selectedIds || selectedIds.length === 0) return '';
  const lines = selectedIds.map(id => {
    const item = CATALOG.find(c => c.id === id);
    if (!item) throw new Error(`Unknown command ID: ${id}`);
    return `- ${binDir}/${id}${item.rawSuffix}`;
  });
  return HINT_HEADING + lines.join('\n');
}

export function checkFactual(id, text) {
  if (!text || typeof text !== 'string') return false;
  if (id === 'F1') {
    return text.includes('8750') || text.includes('8,750');
  }
  if (id === 'F2') {
    return /\bno\b/i.test(text) && text.includes('2.4.1') && text.includes('2.4.0');
  }
  return false;
}

export function parseAnswer(response) {
  if (!response || typeof response !== 'string') return '';
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const lastLine = lines[lines.length - 1];
  const m = lastLine.match(/^ANSWER:\s*(.+)$/i);
  return m ? m[1].trim() : '';
}

export function scoreResponse(id, response, options = {}) {
  // status has no SUCCESS default: a missing envelope status is a failure.
  const { exitCode = 0, signal = null, error = null, status = null } = options;
  if (exitCode !== 0 || signal || error || status !== 'SUCCESS') {
    return {
      factualCorrect: false,
      strictCorrect: false,
      answer: '',
      finalLineCompliant: false,
    };
  }

  const answer = parseAnswer(response);
  const finalLineCompliant = answer.length > 0;
  const factualCorrect = checkFactual(id, response);
  const strictCorrect = finalLineCompliant && checkFactual(id, answer);

  return {
    factualCorrect,
    strictCorrect,
    answer,
    finalLineCompliant,
  };
}

export function calculateTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const keys = ['input_tokens', 'cache_read_tokens', 'output_tokens'];
  for (const k of keys) {
    if (typeof usage[k] !== 'number' || !Number.isFinite(usage[k]) || usage[k] < 0) {
      return null;
    }
  }
  return usage.input_tokens + usage.cache_read_tokens + usage.output_tokens;
}

export function formatTokens(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '-';
  return (val / 1000).toFixed(1) + 'k';
}
