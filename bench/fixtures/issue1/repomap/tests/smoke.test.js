const test = require('node:test');
const app = require('../src/index');

test('smoke', () => { if (!app.run) throw new Error('missing run'); });
