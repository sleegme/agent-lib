const test = require('node:test');
const assert = require('node:assert');
const mod = require('./index');

test('alpha basic', () => assert.ok(mod));
test('alpha stable', () => assert.equal(typeof mod.run, 'function'));
