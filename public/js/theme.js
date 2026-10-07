// Hell/Dunkel-Modus – wird im <head> geladen, damit die Seite nicht kurz hell aufblitzt.
(() => {
  'use strict';

  const KEY = 'ans.theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try { return localStorage.getItem(KEY); } catch { return null; }
  }

  function apply(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#121822' : '#003366';
  }

  // Ohne eigene Wahl folgt die Seite der Systemeinstellung
  apply(saved() || (system.matches ? 'dark' : 'light'));
  system.addEventListener('change', (e) => {
    if (!saved()) apply(e.matches ? 'dark' : 'light');
  });

  window.ANS_THEME = {
    get: () => root.dataset.theme,
    set(theme) {
      try { localStorage.setItem(KEY, theme); } catch { /* Speicher nicht verfügbar */ }
      apply(theme);
    },
  };
})();
