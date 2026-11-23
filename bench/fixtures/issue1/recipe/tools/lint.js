#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src'];
let issues = 0;
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); }
  else if (p.endsWith('.js')) {
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
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
