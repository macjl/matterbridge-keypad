const test = require('node:test');
test('keypad form journey and native authentication UI', async () => {
  await require('./ui.cjs');
  await require('./auth-ui.cjs');
});
