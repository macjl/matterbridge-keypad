const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

module.exports = (async () => {
  for (const plugin of ['matterbridge-securitysystem-keypad']) {
    const root = join(__dirname, '../apps/frontend/build');
    const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), { runScripts: 'outside-only', url: `http://localhost/plugins/${plugin}/` });
    const w = dom.window, d = w.document, calls = [], errors = [];
    let authenticated = false;
    w.setInterval = () => {};
    w.fetch = async (url, options) => {
      calls.push({ url, options });
      return { status: authenticated ? 200 : 401, ok: authenticated, json: async () => ({ error: authenticated ? 'Réponse de test' : 'Unauthorized' }) };
    };
    w.addEventListener('error', (event) => errors.push(event.error));
    w.eval(readFileSync(join(root, 'app.js'), 'utf8'));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    await tick();
    assert.equal(d.getElementById('key'), null);
    assert.equal(d.getElementById('access'), null);
    assert.equal(d.getElementById('auth-message').hidden, false);
    assert.equal(d.querySelector('#auth-message a').getAttribute('href'), '/');
    assert.match(d.getElementById('message').textContent, /Matterbridge/);
    authenticated = true;
    d.getElementById(plugin === 'matterbridge-securitysystem-keypad' ? 'reload' : 'refresh').click();
    await tick();
    assert.equal(d.getElementById('auth-message').hidden, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ options }) => options.credentials === 'same-origin' && !Object.hasOwn(JSON.parse(options.body), 'key')));
    assert.equal(w.localStorage.length, 0);
    assert.deepEqual(errors, []);
    w.close();
  }
  console.log('Trois interfaces : chargement automatique, aucune clé, session Matterbridge requise sur 401 et reprise après connexion.');
})().catch((error) => { throw error; });
