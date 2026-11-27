(() => {
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
    show,
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
