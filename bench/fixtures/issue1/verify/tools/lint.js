#!/usr/bin/env node
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
    const lines = src.split('\n');
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
