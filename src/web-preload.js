// Runs alongside the web pages in the map tabs (the local map and Flightradar24), in its own
// isolated world: the pages themselves cannot see or call anything here.
//
// Its one job: the device has no physical keyboard, so when a text box on a page is touched the
// app is told to show its on-screen keyboard, and told again when typing is over.
const { ipcRenderer } = require('electron');

const NOT_TEXT = /^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i;
const takesText = (el) => Boolean(el) && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TEXT.test(el.type)));
// The element really holding focus, looking inside shadow roots and inside embedded frames that
// belong to the same site (frames from other sites run their own copy of this script).
function focused() {
  let el = document.activeElement;
  for (;;) {
    let inner = null;
    if (el && el.shadowRoot) inner = el.shadowRoot.activeElement;
    else if (el && el.tagName === 'IFRAME') { try { inner = el.contentDocument && el.contentDocument.activeElement; } catch { /* another site's frame */ } }
    if (!inner || inner === el) return el;
    el = inner;
  }
}

function showIfTyping() {
  const el = focused();
  if (!takesText(el)) return;
  ipcRenderer.send('keyboard:show');
  // The page has just been made shorter to make room; bring the text box back into view.
  setTimeout(() => { if (focused() === el) el.scrollIntoView({ block: 'center' }); }, 350);
}
window.addEventListener('focusin', showIfTyping, true);
// Also on a touch: after the keyboard's Hide key the text box still has focus, so touching it
// again gives no new focus event, and the keyboard must still come back.
window.addEventListener('click', showIfTyping, true);

// Touching a key moves focus to the keyboard for a moment, which also looks like "focus left the
// text box". So the keyboard is only dismissed when focus has moved somewhere else within this page.
window.addEventListener('focusout', () => {
  setTimeout(() => { if (document.hasFocus() && !takesText(focused())) ipcRenderer.send('keyboard:hide'); }, 150);
}, true);
