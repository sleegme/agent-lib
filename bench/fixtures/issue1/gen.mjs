// Deterministic fixture generator for the issue #1 experiment shortlist.
// Run once from the repo root:  node bench/fixtures/issue1/gen.mjs
// Produces template trees under bench/fixtures/issue1/<fx>/ ; git-dependent
// state is created at run time by each fixture's setup.sh (executed in the
// per-run scratch copy, never committed).
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)); // bench/fixtures/issue1/
const w = (fx, rel, content, mode) => {
  const p = join(ROOT, fx, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
};
// Shared .gitignore committed by each git fixture's setup.sh so the run-time
// opencode.json / .cap / __pycache__ artifacts stay out of git status.
const GITIGNORE = 'opencode.json\n.cap/\n__pycache__/\n';
const gitEnv = `export GIT_AUTHOR_NAME=bench GIT_AUTHOR_EMAIL=bench@example.com GIT_COMMITTER_NAME=bench GIT_COMMITTER_EMAIL=bench@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
c() { git add -A && git commit -qm "$1"; };

`;

// ---------- FX1: foreach + target-select (30 py files, 12 changed, 6 broken)
rmSync(join(ROOT, 'foreach'), { recursive: true, force: true });
for (let i = 1; i <= 30; i++) {
  const nn = String(i).padStart(2, '0');
  w('foreach', `src/mod_${nn}.py`, `"""module ${nn}"""


def calc_${nn}(x):
    return x * ${i} + ${i % 7}


CONST_${nn} = ${i * 3}
`);
}
w('foreach', '.gitignore', GITIGNORE);
w('foreach', 'setup.sh', `#!/usr/bin/env bash
set -eu
${gitEnv}git init -q -b main .
c 'init fixture'
git update-ref refs/remotes/origin/main HEAD
for i in 02 05 08 11 14 17; do printf 'def broken(:\\n' >> src/mod_$i.py; done
for i in 20 22 24 26 28 30; do printf '# tweaked for bench\\n' >> src/mod_$i.py; done
export GIT_AUTHOR_DATE='2026-01-02T00:00:00Z' GIT_COMMITTER_DATE='2026-01-02T00:00:00Z'
c 'tweak batch'
`, 0o755);
// Answer key: changed-vs-origin/main = 12 files; failing py_compile among
// them: src/mod_02.py 05 08 11 14 17.

// ---------- FX2: compact + fail-only via run-cap (6000-line TAP output)
rmSync(join(ROOT, 'hugeout'), { recursive: true, force: true });
{
  const fails = new Set([103, 1200, 2500, 4100, 5900]);
  let body = 'TAP version 13\n';
  for (let i = 1; i <= 6000; i++) {
    body += fails.has(i) ? `not ok ${i} - check-${String(i).padStart(4, '0')}\n`
                         : `ok ${i} - check-${String(i).padStart(4, '0')}\n`;
  }
  body += `1..${6000}\n# tests 6000\n# pass 5995\n# fail 5\n`;
  w('hugeout', 'run-checks.sh', `#!/usr/bin/env bash
# Simulated check suite: 6000 TAP checks, 5 failures, deterministic order.
cat <<'OUT'
${body}OUT
exit 1
`, 0o755);
  w('hugeout', 'README.md', '# hugeout fixture\n\nRun ./run-checks.sh to execute the check suite (TAP output).\n');
}
// Answer key: 5 failures, first failing check-0103.

// ---------- FX3: repo-map (mixed-language repo, js-majority)
rmSync(join(ROOT, 'repomap'), { recursive: true, force: true });
w('repomap', 'package.json', JSON.stringify({
  name: 'mixtool', version: '1.2.0', main: 'src/index.js',
  scripts: {
    test: 'node --test tests/',
    lint: 'node tools/lint.js',
    build: 'node tools/build.js',
  },
}, null, 2) + '\n');
w('repomap', 'src/index.js', "const { helper } = require('./lib/a');\nconst { other } = require('./lib/b');\n\nmodule.exports = { run: () => helper() + other() };\n");
w('repomap', 'src/lib/a.js', 'module.exports = { helper: () => 1 };\n');
w('repomap', 'src/lib/b.js', 'module.exports = { other: () => 2 };\n');
w('repomap', 'src/util.js', 'module.exports = { clamp: (v) => Math.max(0, Math.min(1, v)) };\n');
w('repomap', 'tools/gen.py', '"""Generates the static asset table."""\n\nTABLE = {i: i * i for i in range(10)}\n\n\ndef main():\n    for k, v in TABLE.items():\n        print(f"{k},{v}")\n');
w('repomap', 'tools/build.js', "console.log('build stub');\n");
w('repomap', 'tests/smoke.test.js', "const test = require('node:test');\nconst app = require('../src/index');\n\ntest('smoke', () => { if (!app.run) throw new Error('missing run'); });\n");
w('repomap', 'README.md', '# mixtool\n\nMixed JS/Python demo tool.\n');
w('repomap', 'docs/usage.md', '# Usage\n\nSee package.json scripts.\n');
// Answer key: JavaScript | node --test tests/ | src/index.js.

// ---------- FX4: git-review (branch ahead, dirty tree)
rmSync(join(ROOT, 'gitreview'), { recursive: true, force: true });
w('gitreview', 'README.md', '# gitreview fixture\n\nRate-limited service skeleton.\n');
w('gitreview', 'config.json', JSON.stringify({ port: 8080, limit: 100 }, null, 2) + '\n');
w('gitreview', 'src/app.js', "const util = require('./util');\n\nmodule.exports = { start: () => util.log('started') };\n");
w('gitreview', 'src/util.js', "module.exports = { log: (m) => process.stdout.write(m + '\\n') };\n");
w('gitreview', '.gitignore', GITIGNORE);
w('gitreview', 'setup.sh', `#!/usr/bin/env bash
set -eu
${gitEnv}git init -q -b main .
git add README.md config.json src/app.js .gitignore && git commit -qm 'chore: initial layout'
git add src/util.js && git commit -qm 'feat: add util helpers'
git checkout -q -b feature/limits
git commit -q --allow-empty -m 'feat: raise limit ceiling'
git commit -q --allow-empty -m 'fix: adjust rate limits'
git update-ref refs/remotes/origin/main HEAD~2
printf '\\n// local tweak\\n' >> src/app.js
printf '\\n// local tweak\\n' >> src/util.js
echo 'scratch notes' > notes.txt
`, 0o755);
// Answer key: feature/limits | ahead 2 | behind 0 | modified 2 | untracked 1 | "fix: adjust rate limits".

// ---------- FX5: verify (tests + lint with fixed failures)
rmSync(join(ROOT, 'verify'), { recursive: true, force: true });
w('verify', 'package.json', JSON.stringify({
  name: 'verifixture', version: '0.3.0',
  scripts: { test: 'node --test tests/', lint: 'node tools/lint.js' },
}, null, 2) + '\n');
w('verify', 'tools/lint.js', `#!/usr/bin/env node
// usage: node tools/lint.js [paths...]  (default src)
// Flags any .js file containing console.log. Prints one "Lint issue in <file>"
// line per hit plus an indented rule line; exit 1 when any issue found.
const fs = require('fs');
const path = require('path');
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src'];
let issues = 0;
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
  } else if (p.endsWith('.js')) {
    const src = fs.readFileSync(p, 'utf8');
    const lines = src.split('\\n');
    lines.forEach((line, i) => {
      if (line.includes('console.log')) {
        issues++;
        console.log('Lint issue in ' + path.relative(process.cwd(), p));
        console.log('  rule: no-console (line ' + (i + 1) + ')');
      }
    });
  }
};
for (const r of roots) walk(r);
process.exit(issues ? 1 : 0);
`);
w('verify', 'src/clean.js', "module.exports = { ok: () => 'fine' };\n");
w('verify', 'src/debug.js', "module.exports = { dump: () => {\n  console.log('dumping');\n  return 'dumped';\n} };\n");
w('verify', 'tests/core.test.js', `const test = require('node:test');
const assert = require('node:assert');

test('adds numbers', () => assert.equal(1 + 1, 2));
test('subtracts numbers', () => assert.equal(3 - 1, 2));
test('multiplies numbers', () => assert.equal(2 * 3, 7));
test('parses config', () => { throw new Error('parse boom'); });
`);
w('verify', 'tests/io.test.js', `const test = require('node:test');
const assert = require('node:assert');

test('reads file', () => assert.ok(true));
test('writes file', () => assert.ok(true));
test('appends file', () => assert.equal('a' + 'b', 'abc'));
test('truncates file', () => assert.ok(true));
`);
w('verify', 'README.md', '# verifixture\n\nnpm test / npm run lint\n');
// Answer key: tests FAIL (multiplies numbers, parses config, appends file);
// lint FAIL (src/debug.js).

// ---------- FX6: recipe (saved multi-step operation on module alpha)
rmSync(join(ROOT, 'recipe'), { recursive: true, force: true });
const modTest = (name) => `const test = require('node:test');\nconst assert = require('node:assert');\nconst mod = require('./index');\n\ntest('${name} basic', () => assert.ok(mod));\ntest('${name} stable', () => assert.equal(typeof mod.run, 'function'));\n`;
for (const m of ['alpha', 'beta', 'gamma']) {
  w('recipe', `src/modules/${m}/index.js`, `module.exports = { run: () => '${m}-ok' };\n`);
  w('recipe', `src/modules/${m}/${m}.test.js`, modTest(m));
}
w('recipe', 'tools/lint.js', `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src'];
let issues = 0;
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); }
  else if (p.endsWith('.js')) {
    fs.readFileSync(p, 'utf8').split('\\n').forEach((line, i) => {
      if (line.includes('console.log')) {
        issues++;
        console.log('Lint issue in ' + path.relative(process.cwd(), p));
        console.log('  rule: no-console (line ' + (i + 1) + ')');
      }
    });
  }
};
for (const r of roots) walk(r);
process.exit(issues ? 1 : 0);
`);
w('recipe', '.agent-lib/recipes/module-report.recipe', `# Status report for one module. Parameters: $module
node --test src/modules/$module
node tools/lint.js src/modules/$module
git log -1 --format=%s -- src/modules/$module
`);
w('recipe', 'package.json', JSON.stringify({ name: 'recipetree', version: '0.1.0' }, null, 2) + '\n');
w('recipe', 'README.md', '# recipetree\n\nModules under src/modules.\n');
w('recipe', '.gitignore', GITIGNORE);
w('recipe', 'setup.sh', `#!/usr/bin/env bash
set -eu
${gitEnv}git init -q -b main .
git add src/modules/beta tools package.json README.md .gitignore .agent-lib
git commit -qm 'feat: add beta module'
git add src/modules/alpha
git commit -qm 'feat: add alpha module'
git add src/modules/gamma
git commit -qm 'feat: add gamma module'
`, 0o755);
// Answer key (module=alpha): test=PASS lint=PASS commit="feat: add alpha module".

// ---------- FX7: ship --plan (release preflight, NO-GO state)
rmSync(join(ROOT, 'ship'), { recursive: true, force: true });
w('ship', 'package.json', JSON.stringify({
  name: 'shipfix', version: '2.4.1',
  scripts: { test: 'node --test tests/' },
}, null, 2) + '\n');
w('ship', 'VERSION', '2.4.0\n');
w('ship', 'CHANGELOG.md', '# Changelog\n\n## 2.4.0\n\n- rate limit fixes\n- logging cleanup\n');
w('ship', 'tests/unit.test.js', `const test = require('node:test');
const assert = require('node:assert');

test('formats output', () => assert.equal(2, 3));
test('loads config', () => assert.ok(true));
`);
w('ship', 'README.md', '# shipfix\n\nRelease candidate fixture.\n');
w('ship', '.gitignore', GITIGNORE);
w('ship', 'setup.sh', `#!/usr/bin/env bash
set -eu
${gitEnv}git init -q -b main .
git add .gitignore package.json VERSION CHANGELOG.md tests README.md
git commit -qm 'chore: release prep state'
printf '\\n<!-- late note -->\\n' >> README.md
`, 0o755);
// Answer key: NO-GO; failed = version-mismatch (2.4.1 vs 2.4.0),
// changelog-missing-entry (2.4.1), tests-fail (formats output), dirty-tree (README).

console.log('fixtures generated under', ROOT);
