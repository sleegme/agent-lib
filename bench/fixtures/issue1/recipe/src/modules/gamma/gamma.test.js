const test = require('node:test');
const assert = require('node:assert');
const mod = require('./index');

test('gamma basic', () => assert.ok(mod));
test('gamma stable', () => assert.equal(typeof mod.run, 'function'));
