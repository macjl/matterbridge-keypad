(() => {
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  const language = preferred.map((locale) => locale?.toLowerCase().split('-')[0])
    .find((candidate) => candidate === 'en' || candidate === 'fr') ?? 'en';
  const { french = {}, serverEnglish = {} } = window.PluginMessages ?? {};
  const interpolate = (text, values) => text.replace(/\{(\d+)\}/g, (part, index) => values[index] ?? part);
  const t = (message, ...values) => interpolate(language === 'fr' && Object.hasOwn(french, message) ? french[message] : message, values);

  const serverPatterns = Object.entries(serverEnglish).filter(([message]) => /\{\d+\}/.test(message)).map(([message, translated]) => {
    const parts = message.split(/\{\d+\}/);
    const escapeRegex = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [new RegExp('^' + parts.map(escapeRegex).join('(.*?)') + '$', 's'), translated];
  });
  function serverText(message) {
    if (language !== 'en' || typeof message !== 'string' || !message) return message;
    if (Object.hasOwn(serverEnglish, message)) return serverEnglish[message];
    for (const [pattern, translation] of serverPatterns) {
      const match = pattern.exec(message);
      if (match) return interpolate(translation, match.slice(1));
    }
    return message;
  }

  const defaultProfiles = { default: 'Défaut', arming: 'Pré-armement', prealarm: 'Préalarme', alarm: 'Alarme' };
  function profileName(id, name) {
    return Object.hasOwn(defaultProfiles, id) && name === defaultProfiles[id] ? serverText(name) : name;
  }

  document.documentElement.lang = language;
  if (language === 'fr') {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const key = node.data.trim();
      if (Object.hasOwn(french, key)) node.data = node.data.replace(key, french[key]);
    }
    for (const element of document.querySelectorAll('[placeholder], [title], [aria-label]')) {
      for (const attribute of ['placeholder', 'title', 'aria-label']) {
        const value = element.getAttribute(attribute);
        if (value && Object.hasOwn(french, value)) element.setAttribute(attribute, french[value]);
      }
    }
  }
  const tabs = Array.from(document.querySelectorAll('[role=tab]'));
  function show(name, focus = false) {
    if (!tabs.some((tab) => tab.dataset.panel === name)) name = 'overview';
    for (const tab of tabs) {
      const active = tab.dataset.panel === name;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) tab.focus();
    }
    history.replaceState(null, '', '#' + name);
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => show(tab.dataset.panel));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); show(tabs[next].dataset.panel, true); }
    });
  }
  window.PluginUI = {
    show, t, serverText, profileName, language,
    empty(id, text) {
      const list = document.getElementById(id);
      if (!list || list.children.length) return;
      const item = document.createElement('li'); item.className = 'empty-state'; item.textContent = text; list.append(item);
    },
    busy(active) {
      document.querySelector('main').setAttribute('aria-busy', String(active));
      const refresh = document.querySelector('.page-header button'); if (refresh) refresh.disabled = active;
    },
  };
  show(location.hash.slice(1));
})();
