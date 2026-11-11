// The on-screen keyboard, used by the Settings page (Wi-Fi passwords) and by keyboard.html (typing
// into web pages such as the Flightradar24 sign-in). Styled by the .keyboard rules in theme.css.
//
//   onScreenKeyboard(container, { onType(character), onDelete(), onEnter(), extraKeys: [{ label, className, onPress }] })
//
// Delete and Enter sit where a computer keyboard has them: Delete at the top right, Enter at the right
// of the middle row. The bottom row always has @, space and a full stop; extraKeys are added to its end. Returns { reset() } to go back to lower-case letters.
const KEY_LAYERS = {
  abc: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  num: ['1234567890', '@#£$%&*-+=', '!"\'():;/?'],
  sym: ['~`|\\{}[]<>', '^_,.€', ''],
};

function onScreenKeyboard(container, { onType, onDelete, onEnter, extraKeys = [] }) {
  let layer = 'abc', shift = false;
  container.classList.add('keyboard');

  function key(label, onPress, className) {
    const b = document.createElement('button');
    b.textContent = label;
    if (className) b.className = className;
    b.addEventListener('click', onPress);
    return b;
  }

  function draw() {
    container.replaceChildren();
    const type = (ch) => () => {
      onType(ch);
      if (shift) { shift = false; draw(); } // shift applies to one letter
    };
    KEY_LAYERS[layer].forEach((chars, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      if (i === 2) {
        row.append(layer === 'abc'
          ? key('Shift', () => { shift = !shift; draw(); }, 'wide' + (shift ? ' on' : ''))
          : key(layer === 'num' ? '#+=' : '123', () => { layer = layer === 'num' ? 'sym' : 'num'; draw(); }, 'wide'));
      }
      for (const ch of chars) {
        const out = layer === 'abc' && shift ? ch.toUpperCase() : ch;
        row.append(key(out, type(out)));
      }
      if (i === 0) row.append(key('Delete', onDelete, 'wide'));
      if (i === 1 && onEnter) row.append(key('Enter', onEnter, 'wide on'));
      container.append(row);
    });
    const last = document.createElement('div');
    last.className = 'row';
    last.append(
      key(layer === 'abc' ? '123' : 'ABC', () => { layer = layer === 'abc' ? 'num' : 'abc'; shift = false; draw(); }, 'wide'),
      key('@', type('@')),      // always to hand: e-mail addresses need both
      key('space', type(' '), 'wide space'),
      key('.', type('.')),
      ...extraKeys.map((extra) => key(extra.label, extra.onPress, `wide ${extra.className || ''}`)),
    );
    container.append(last);
  }

  draw();
  return { reset() { layer = 'abc'; shift = false; draw(); } };
}
