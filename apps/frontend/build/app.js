const $ = (id) => document.getElementById(id);
const credentialForm = $('credential-form'), routeForm = $('route-form'), settingsForm = $('settings-form');
const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
const session = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
let current, opened = false, pending = 0, chain = Promise.resolve(), credentialId, routeId;

async function api(action, fields = {}) {
  const response = await fetch(`./api/${action}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ session, ...fields }),
  });
  $('auth-message').hidden = response.status !== 401;
  if (response.status === 401) throw new Error('Connexion à Matterbridge requise.');
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Le plugin est indisponible.');
  return data;
}
function enqueue(work) {
  pending++;
  const next = chain.then(async () => {
    try { await work(); }
    catch (error) { $('message').textContent = error.message; }
    finally { pending--; }
  });
  chain = next.catch(() => {});
  return next;
}
function request(action, fields = {}, after) {
  return enqueue(async () => {
    const data = await api(action, fields); render(data, action === 'settings' || !opened);
    opened = true; $('message').textContent = ''; after?.(data);
  });
}
function button(label, callback, disabled = false) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.disabled = disabled;
  node.addEventListener('click', callback); return node;
}
function row(label, buttons) {
  const item = document.createElement('li'), text = document.createElement('span'); text.className = 'row-label'; text.textContent = label;
  item.append(text, ...buttons); return item;
}
function render(data, configuration = false) {
  current = data; $('controls').hidden = false; $('connection').textContent = 'Connecté';
  $('selection').textContent = data.input.route || (data.input.prefix ? `Préfixe ${data.input.prefix} : aucune séquence active` : 'Choisis une séquence.');
  $('digits').textContent = data.input.entered ? '•'.repeat(data.input.entered) : '—';
  const lock = Math.max(0, Math.ceil((data.input.lockedUntil - Date.now()) / 1000));
  $('input-state').textContent = lock ? `Clavier bloqué : ${lock} s` : data.input.busy ? 'Commande en cours…' : data.input.lastResult?.message || '';
  $('shortcuts').replaceChildren(...data.routes.filter((r) => r.enabled).map((r) => button(`${r.prefix} · ${r.name}`, () => enqueue(async () => {
    let result = await api('clear');
    for (const symbol of r.prefix) result = await api('key', { symbol });
    render(result); $('message').textContent = '';
  }), !!lock || data.input.busy)));
  for (const key of document.querySelectorAll('[data-key]')) key.disabled = !!lock || data.input.busy;
  $('usb-state').textContent = !data.usb.enabled ? 'Pavé USB désactivé.' : data.usb.connected ? `USB connecté : ${data.usb.name}` : `USB en attente : ${data.usb.error || 'recherche du périphérique'}`;
  $('controller-state').textContent = `${data.peers.filter((p) => p.connected).length} appareil(s) Matter connecté(s). Contrôleur : ${data.controller.label}.`;
  $('history').replaceChildren(...data.history.map((event) => {
    const item = document.createElement('li'); item.textContent = `${new Date(event.at).toLocaleString()} · ${event.source} · ${event.message}`; return item;
  }));
  $('credentials').replaceChildren(...data.credentials.map((c) => row(`${c.name} · ${c.enabled ? 'actif' : 'désactivé'}`, [
    button('Modifier', () => editCredential(c)), button('Supprimer', () => {
      if (confirm(`Supprimer le code « ${c.name} » ?`)) request('remove-credential', { id: c.id }, () => { if (credentialId === c.id) editCredential(); renderCodeChoices(); });
    }),
  ])));
  $('routes').replaceChildren(...data.routes.map((r) => row(`${r.prefix} · ${r.name} · ${r.enabled ? 'active' : 'désactivée'} · ${r.operations.length} commande(s)`, [
    button('Modifier', () => editRoute(r)), button('Supprimer', () => {
      if (confirm(`Supprimer la séquence « ${r.name} » ?`)) request('remove-route', { id: r.id }, () => { if (routeId === r.id) editRoute(); });
    }),
  ])));
  $('peers').replaceChildren(...data.peers.map((p) => row(`${p.label} · ${p.connected ? 'connecté' : 'hors ligne'} · ${p.endpoints.length} commande(s) disponible(s)`, [
    button('Retirer', () => { if (confirm(`Retirer « ${p.label} » de ce contrôleur ?`)) request('remove-device', { peer: p.id }); }),
  ])));
  for (const [id, text] of [['credentials', 'Aucun code autorisé. Créer un code avant d’utiliser une séquence.'], ['routes', 'Aucune séquence. Associer un préfixe à des commandes Matter.'], ['peers', 'Aucun appareil associé à ce clavier.'], ['history', 'Aucune commande enregistrée.']]) window.PluginUI?.empty(id, text);
  if (configuration) {
    for (const [name, value] of Object.entries(data.settings)) {
      const field = settingsForm.elements.namedItem(name); if (!field) continue;
      if (field.type === 'checkbox') field.checked = value; else field.value = value;
    }
    renderCodeChoices();
  }
}
function editCredential(credential) {
  if (credential) credentialForm.closest('details').open = true;
  credentialId = credential?.id; credentialForm.reset();
  $('credential-title').textContent = credential ? `Modifier ${credential.name}` : 'Nouveau code';
  credentialForm.elements.pin.required = !credential;
  credentialForm.elements.pin.placeholder = credential ? 'Laisser vide pour conserver le code' : '4 à 12 chiffres';
  if (credential) { credentialForm.elements.name.value = credential.name; credentialForm.elements.enabled.checked = credential.enabled; }
}
function renderCodeChoices(selected) {
  const previous = selected ?? Array.from($('route-codes').querySelectorAll('input:checked'), (i) => i.value);
  $('route-codes').replaceChildren(...(current?.credentials ?? []).map((c) => {
    const label = document.createElement('label'); label.className = 'check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = c.id; input.checked = previous.includes(c.id);
    label.append(input, document.createTextNode(c.name + (c.enabled ? '' : ' (désactivé)'))); return label;
  }));
  $('route-codes').hidden = $('all-codes').checked;
}
function endpoints() {
  return (current?.peers ?? []).flatMap((p) => p.endpoints.map((e) => ({ ...e, peer: p.id, title: `${e.label} · ${p.label} · #${e.number}` })));
}
function operationRow(saved) {
  const item = document.createElement('div'); item.className = 'operation';
  const target = document.createElement('select'); target.setAttribute('aria-label', 'Accessoire');
  const command = document.createElement('select'); command.setAttribute('aria-label', 'Commande');
  let value = document.createElement('input');
  const targets = endpoints();
  target.append(new Option('Choisir un accessoire', ''));
  for (const part of targets) target.append(new Option(part.title, `${part.peer}:${part.number}`));
  let fallback;
  if (saved && !targets.some((p) => p.peer === saved.peer && p.number === saved.endpoint)) {
    fallback = { peer: saved.peer, number: saved.endpoint, commands: [{ id: saved.command, label: saved.command, ...(saved.command === 'profile' ? { choices: [{ value: saved.value, label: saved.valueLabel || saved.value }] } : {}) }] };
    target.append(new Option((saved.label || saved.peer) + ' (indisponible)', `${saved.peer}:${saved.endpoint}`));
  }
  const part = () => targets.find((p) => `${p.peer}:${p.number}` === target.value) || (target.value ? fallback : undefined);
  function drawValue(initial) {
    const capability = part()?.commands.find((c) => c.id === command.value);
    let replacement;
    if (capability?.choices) {
      replacement = document.createElement('select');
      for (const choice of capability.choices) replacement.append(new Option(choice.label, choice.value));
      if (initial !== undefined && !capability.choices.some((c) => c.value === initial)) replacement.append(new Option((saved?.valueLabel || initial) + ' (indisponible)', initial));
      replacement.required = true;
    } else {
      replacement = document.createElement('input');
      if (command.value === 'color') replacement.type = 'color';
      else if (['brightness', 'volume', 'temperature'].includes(command.value)) {
        replacement.type = 'number'; replacement.min = capability?.min ?? (command.value === 'temperature' ? 1000 : 0);
        replacement.max = capability?.max ?? (command.value === 'temperature' ? 20000 : 100); replacement.required = true;
      } else { replacement.type = 'text'; replacement.disabled = true; replacement.placeholder = 'Sans valeur'; }
    }
    replacement.setAttribute('aria-label', 'Valeur');
    if (initial !== undefined) replacement.value = initial;
    else if (replacement.type === 'color') replacement.value = '#ffffff';
    else if (replacement.type === 'number') replacement.value = command.value === 'temperature' ? '3000' : '100';
    value.replaceWith(replacement); value = replacement;
  }
  function drawCommands(initial) {
    command.replaceChildren(...(part()?.commands ?? []).map((c) => new Option(c.label, c.id)));
    if (initial && !Array.from(command.options).some((o) => o.value === initial)) command.append(new Option(initial + ' (indisponible)', initial));
    if (initial) command.value = initial;
    drawValue(initial === saved?.command ? saved?.value : undefined);
  }
  target.required = command.required = true;
  item.append(target, command, value, button('Retirer', () => item.remove()));
  target.addEventListener('change', () => drawCommands()); command.addEventListener('change', () => drawValue());
  if (saved) target.value = `${saved.peer}:${saved.endpoint}`;
  drawCommands(saved?.command);
  item.operation = () => {
    const selected = part(); if (!selected || !command.value) throw new Error('Choisis un accessoire et une commande.');
    return { peer: selected.peer, endpoint: selected.number, command: command.value,
      ...(['brightness', 'volume', 'temperature'].includes(command.value) ? { value: Number(value.value) }
        : ['color', 'profile'].includes(command.value) ? { value: value.value } : {}) };
  };
  return item;
}
function editRoute(route) {
  if (route) routeForm.closest('details').open = true;
  routeId = route?.id; routeForm.reset(); $('route-title').textContent = route ? `Modifier ${route.name}` : 'Nouvelle séquence';
  if (route) {
    routeForm.elements.name.value = route.name; routeForm.elements.prefix.value = route.prefix; routeForm.elements.enabled.checked = route.enabled;
    $('all-codes').checked = route.credentialIds === null;
  }
  renderCodeChoices(route?.credentialIds ?? []);
  $('operations').replaceChildren(...(route?.operations ?? [undefined]).map(operationRow));
}
function load() { return request('status', { refresh: true }, () => { if (!$('operations').children.length) editRoute(); }); }
$('reload').addEventListener('click', load);
for (const key of document.querySelectorAll('[data-key]')) key.addEventListener('click', () => request('key', { symbol: key.dataset.key }));
$('refresh').addEventListener('click', () => request('status', { refresh: true }));
$('all-codes').addEventListener('change', () => { $('route-codes').hidden = $('all-codes').checked; });
$('add-operation').addEventListener('click', () => $('operations').append(operationRow()));
$('cancel-route').addEventListener('click', () => editRoute()); $('cancel-credential').addEventListener('click', () => editCredential());
credentialForm.addEventListener('submit', (event) => {
  event.preventDefault(); const f = credentialForm.elements;
  request('credential', { ...(credentialId ? { id: credentialId } : {}), name: f.name.value, pin: f.pin.value, enabled: f.enabled.checked }, () => { editCredential(); renderCodeChoices(); });
  f.pin.value = '';
});
routeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const f = routeForm.elements;
    const operations = Array.from($('operations').children, (item) => item.operation());
    request('route', { ...(routeId ? { id: routeId } : {}), name: f.name.value, prefix: f.prefix.value, enabled: f.enabled.checked,
      credentialIds: $('all-codes').checked ? null : Array.from($('route-codes').querySelectorAll('input:checked'), (i) => i.value), operations }, () => editRoute());
  } catch (error) { $('message').textContent = error.message; }
});
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault(); const f = settingsForm.elements;
  request('settings', { settings: { usbEnabled: f.usbEnabled.checked, devicePath: f.devicePath.value.trim(), exclusive: f.exclusive.checked,
    inputSeconds: Number(f.inputSeconds.value), maxAttempts: Number(f.maxAttempts.value), lockSeconds: Number(f.lockSeconds.value) } });
});
$('pair-form').addEventListener('submit', (event) => {
  event.preventDefault(); const field = event.target.elements.code;
  request('pair-device', { code: field.value }); field.value = '';
});
document.addEventListener('keydown', (event) => {
  if (!opened || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.closest?.('input,select,textarea,form,button,a,summary') || $('panel-overview').hidden) return;
  if (/^(?:[0-9+*/.\-]|Enter|Backspace|Escape)$/.test(event.key)) { event.preventDefault(); request('key', { symbol: event.key }); }
});
setInterval(async () => {
  if (!opened || pending) return;
  pending++;
  try { render(await api('status')); }
  catch (error) { $('message').textContent = error.message; $('connection').textContent = 'Connexion perdue'; }
  finally { pending--; }
}, 2000);
void load();
