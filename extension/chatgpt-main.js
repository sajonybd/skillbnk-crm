// Runs in the ChatGPT page itself (not the extension sandbox). It tells the page it is always visible, so ChatGPT keeps drawing its answer
// while the work window is behind your other windows or you are on another tab. It changes nothing else.
(() => {
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.hasFocus = () => true; // the editor ignores typing and Send when it thinks the window has no focus
    window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch { /* leave the page alone if it refuses */ }
})();
