const test = require('node:test');
const assert = require('node:assert');
const mod = require('./index');

test('beta basic', () => assert.ok(mod));
test('beta stable', () => assert.equal(typeof mod.run, 'function'));
