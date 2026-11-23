const test = require('node:test');
const assert = require('node:assert');

test('adds numbers', () => assert.equal(1 + 1, 2));
test('subtracts numbers', () => assert.equal(3 - 1, 2));
test('multiplies numbers', () => assert.equal(2 * 3, 7));
test('parses config', () => { throw new Error('parse boom'); });
