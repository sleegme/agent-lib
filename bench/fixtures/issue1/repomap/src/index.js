const { helper } = require('./lib/a');
const { other } = require('./lib/b');

module.exports = { run: () => helper() + other() };
