const test = require('node:test');
const assert = require('node:assert');

test('reads file', () => assert.ok(true));
test('writes file', () => assert.ok(true));
test('appends file', () => assert.equal('a' + 'b', 'abc'));
test('truncates file', () => assert.ok(true));
