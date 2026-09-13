/* End-to-end test with a stub DOM: extracts the inline <script> from
   index.html and executes it against a minimal DOM/Canvas implementation.
   Verifies the real UI wiring (pointer gestures, grip drag, undo/redo,
   save/refresh, play, frame switching), not just the model. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n', e); process.exitCode = 1; }
}

/* ---------- stub canvas 2d context ---------- */

function makeCtx() {
  return {
    fillStyle: '',
    clearRect() {},
    fillRect() {},
    sheet: new Array(256).fill('')
  };
}

function listeners() {
  return {
    _m: {},
    addEventListener(t, fn) { (this._m[t] = this._m[t] || []).push(fn); },
    dispatch(t, ev) {
      (this._m[t] || []).slice().forEach(fn => {
        try { fn(ev); } catch (e) { console.error('  [handler error]', e); throw e; }
      });
    }
  };
}

function makeCanvas() {
  const cv = Object.assign(listeners(), {
    width: 16, height: 16, style: {},
    context: makeCtx(),
    getContext() { return this.context; },
    rect: { left: 0, top: 0, width: 320, height: 320 },
    getBoundingClientRect() { return this.rect; },
    setPointerCapture() {},
    toDataURL() { return 'data:image/png;base64,STUB'; }
  });
  return cv;
}

function makeEl(id) {
  const el = Object.assign(listeners(), {
    id: id || '', textContent: '', value: '', checked: false,
    style: {}, dataset: {}, children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) { force ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    appendChild(ch) { this.children.push(ch); return ch; },
    click() {},
    setPointerCapture() {},
    _props: {},
    set onclick(fn) { this._props.click = fn; },
    get onclick() { return this._props.click; },
    set onchange(fn) { this._props.change = fn; },
    get onchange() { return this._props.change; },
    set oninput(fn) { this._props.input = fn; },
    get oninput() { return this._props.input; }
  });
  // real DOM: assigning innerHTML replaces all children (accessor defined
  // directly — Object.assign would have flattened a getter into a value)
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = v; this.children = []; },
    configurable: true
  });
  const rawDispatch = el.dispatch.bind(el);
  el.dispatch = function (t, ev) {
    rawDispatch(t, ev);
    if (this._props[t]) this._props[t](ev || {});
    if (this._bubbleTo) this._bubbleTo.dispatchDoc(t, ev || {});
  };
  return el;
}

function makeButton(data) {
  const b = makeEl();
  b.dataset = data || {};
  return b;
}

/* ---------- build the boot environment ---------- */

function boot(storage) {
  const storageImpl = storage || {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); }
  };

  const canvas = makeCanvas();
  const onion = makeCanvas();
  const els = {};
  [
    'canvaswrap', 'axisV', 'gripV', 'axisH', 'gripH', 'wrapbadge',
    'wrap', 'frames', 'onionToggle', 'opacity', 'custom', 'zoom', 'grid',
    'swatches', 'addFrame', 'duplicate', 'addLayer', 'layers',
    'undo', 'redo', 'fps', 'save', 'export', 'play', 'status'
  ].forEach(id => { els[id] = makeEl(id); });

  els.zoom.value = '20';
  els.opacity.value = '23';
  els.grid.checked = true;
  els.fps.value = '8';
  els.custom.value = '#ff7aa8';

  const toolButtons = ['pencil', 'eraser', 'fill', 'picker'].map(t => makeButton({ tool: t }));
  const symButtons = ['off', 'horizontal', 'vertical', 'quad'].map(s => makeButton({ sym: s }));

  const docListeners = listeners();
  const documentStub = {
    toolButtons,
    symButtons,
    getElementById(id) {
      if (id === 'canvas') return canvas;
      if (id === 'onion') return onion;
      return els[id];
    },
    querySelectorAll(sel) {
      if (sel === '.tool') return toolButtons;
      if (sel === '#symbtns button') return symButtons;
      if (sel === '.sw') return swatchButtons;
      return [];
    },
    createElement(tag) {
      const el = tag === 'canvas' ? makeCanvas() : makeEl('dyn-' + tag);
      el._bubbleTo = documentStub;
      return el;
    },    addEventListener: docListeners.addEventListener.bind(docListeners),
    dispatchDoc: docListeners.dispatch.bind(docListeners)
  };

  // Swatch buttons are parsed from the innerHTML string the app generates.
  let swatchButtons = [];
  function parseSwatches() {
    swatchButtons = [];
    const re = /data-c="(#[0-9a-f]{6})"/g;
    let m;
    while ((m = re.exec(els.swatches.innerHTML))) swatchButtons.push(makeButton({ c: m[1] }));
  }

  const timers = [];
  const sandbox = {
    document: documentStub,
    localStorage: storageImpl,
    setInterval(fn, ms) { const id = timers.length; timers.push({ fn, ms, type: 'i' }); return id; },
    clearInterval(id) { if (timers[id]) timers[id] = null; },
    setTimeout(fn) { const id = timers.length; timers.push({ fn, type: 't' }); return id; },
    clearTimeout() {},
    console,
    PixelLoom: require('../loom.js')
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(m, 'inline app script found in index.html');
  vm.runInContext(m[1], sandbox, { filename: 'index.html#inline' });
  parseSwatches();

  // all UI events bubble to document (autosave listens there)
  canvas._bubbleTo = documentStub;
  Object.values(els).forEach(el => { el._bubbleTo = documentStub; });

  return { sb: sandbox, doc: documentStub, els, canvas, onion, timers, storage: storageImpl };
}

/* ---------- helpers ---------- */

function cellEvent(x, y) {
  return { clientX: x * 20 + 10, clientY: y * 20 + 10, pointerId: 1 };
}

function draw(cv, x0, y0, x1, y1) {
  cv.dispatch('pointerdown', cellEvent(x0, y0));
  if (x1 !== undefined) cv.dispatch('pointermove', cellEvent(x1, y1));
  cv.dispatch('pointerup', cellEvent(x1 !== undefined ? x1 : x0, y1 !== undefined ? y1 : y0));
}

function saved(app) {
  app.els.save.onclick();
  return JSON.parse(app.storage._data.pixelLoom);
}

function gripEv(clientX, clientY) {
  return { pointerId: 1, clientX: clientX, clientY: clientY, preventDefault() {}, stopPropagation() {} };
}

/* ================= tests ================= */

test('boot: axes hidden, wrap badge hidden, swatches rendered', () => {
  const a = boot();
  assert.ok(a.els.swatches.innerHTML.includes('data-c="#ff7aa8"'));
  assert.strictEqual(a.els.axisV.style.display, 'none');
  assert.strictEqual(a.els.axisH.style.display, 'none');
  assert.strictEqual(a.els.wrapbadge.style.display, 'none');
  assert.strictEqual(a.els.canvaswrap.classList.contains('wrapon'), false);
});

test('pencil paints exact cell; document is v2', () => {
  const a = boot();
  draw(a.canvas, 3, 4);
  const d = saved(a);
  assert.strictEqual(d.v, 2);
  assert.strictEqual(d.frames[0][4 * 16 + 3], '#ff7aa8');
  assert.strictEqual(d.frames[0][0], '');
});

test('dragging pencil interpolates between cells', () => {
  const a = boot();
  draw(a.canvas, 0, 0, 4, 0);
  const f = saved(a).frames[0];
  for (let x = 0; x <= 4; x++) assert.strictEqual(f[x], '#ff7aa8');
  assert.strictEqual(f[5], '');
});

test('eraser removes pixels', () => {
  const a = boot();
  draw(a.canvas, 2, 2);
  a.doc.toolButtons[1].onclick();
  draw(a.canvas, 2, 2);
  assert.strictEqual(saved(a).frames[0][2 * 16 + 2], '');
});

test('picker sets current color without mutating pixels', () => {
  const a = boot();
  draw(a.canvas, 5, 5);
  const before = saved(a).frames[0][5 * 16 + 5];
  a.doc.toolButtons[3].onclick();
  a.canvas.dispatch('pointerdown', cellEvent(5, 5));
  assert.strictEqual(a.els.custom.value, '#ff7aa8');
  assert.strictEqual(saved(a).frames[0][5 * 16 + 5], before);
});

test('fill tool paints the empty sheet', () => {
  const a = boot();
  a.doc.toolButtons[2].onclick();
  a.canvas.dispatch('pointerdown', cellEvent(0, 0));
  assert.ok(saved(a).frames[0].every(v => v === '#ff7aa8'));
});

test('symmetry buttons toggle axis overlay and persist mode', () => {
  const a = boot();
  a.doc.symButtons[3].onclick();
  assert.notStrictEqual(a.els.axisV.style.display, 'none');
  assert.notStrictEqual(a.els.axisH.style.display, 'none');
  assert.strictEqual(saved(a).symmetry, 'quad');
  a.doc.symButtons[0].onclick();
  assert.strictEqual(a.els.axisV.style.display, 'none');
});

test('quad painting mirrors one dab to four cells', () => {
  const a = boot();
  a.doc.symButtons[3].onclick();
  draw(a.canvas, 2, 5);
  const f = saved(a).frames[0];
  [5 * 16 + 2, 5 * 16 + 13, 10 * 16 + 2, 10 * 16 + 13].forEach(i => {
    assert.strictEqual(f[i], '#ff7aa8', 'idx ' + i);
  });
});

test('grip drag: axis effective immediately; painting follows new axis', () => {
  const a = boot();
  a.doc.symButtons[2].onclick(); // vertical
  const g = a.els.gripV;
  g.dispatch('pointerdown', gripEv(160, 160));
  g.dispatch('pointermove', gripEv(210, 160)); // -> 10.5 cells
  assert.strictEqual(g.style.left, (10.5 / 16 * 100) + '%');
  draw(a.canvas, 6, 0);
  const f = saved(a).frames[0];
  assert.strictEqual(f[6], '#ff7aa8');
  assert.strictEqual(f[14], '#ff7aa8'); // mirror across 10.5
  assert.strictEqual(f[9], '');        // old-axis mirror would be 9
  g.dispatch('pointerup', gripEv(210, 160));
  assert.strictEqual(saved(a).axisV, 10.5);
});

test('grip drag clamps at edge boundaries 0 and n', () => {
  const a = boot();
  a.doc.symButtons[2].onclick();
  const g = a.els.gripV;
  g.dispatch('pointerdown', gripEv(160, 160));
  g.dispatch('pointermove', gripEv(-999, 160));
  assert.strictEqual(g.style.left, '0%');
  g.dispatch('pointermove', gripEv(9999, 160));
  assert.strictEqual(g.style.left, '100%');
  g.dispatch('pointerup', gripEv(9999, 160));
  draw(a.canvas, 0, 0); // axis at 16 mirrors everything out
  const f = saved(a).frames[0];
  assert.strictEqual(f[0], '#ff7aa8');
  assert.strictEqual(f[31], '');
});

test('wrap off clips at edge; wrap on strokes across the seam', () => {
  const a = boot();
  draw(a.canvas, 15, 0);
  assert.strictEqual(saved(a).frames[0][15], '#ff7aa8');
  assert.strictEqual(saved(a).frames[0][0], '');

  a.els.wrap.checked = true;
  a.els.wrap.onchange({ target: { checked: true } });
  a.canvas.dispatch('pointerdown', { pointerId: 1, clientX: 15 * 20 + 10, clientY: 10 });
  a.canvas.dispatch('pointermove', { pointerId: 1, clientX: 16 * 20 + 10, clientY: 10 });
  a.canvas.dispatch('pointerup', { pointerId: 1, clientX: 16 * 20 + 10, clientY: 10 });
  const f = saved(a).frames[0];
  assert.strictEqual(f[0], '#ff7aa8');
  assert.strictEqual(f[15], '#ff7aa8');
  assert.strictEqual(saved(a).wrap, true);
  assert.strictEqual(a.els.wrapbadge.style.display, 'block');
});

test('wrapped fill paints the whole torus sheet from an edge click', () => {
  const a = boot();
  a.els.wrap.checked = true;
  a.els.wrap.onchange({ target: { checked: true } });
  a.doc.toolButtons[2].onclick();
  a.canvas.dispatch('pointerdown', cellEvent(0, 0));
  const f = saved(a).frames[0];
  assert.strictEqual(f.length, 256);
  assert.ok(f.every(v => v === '#ff7aa8'));
});

test('undo/redo restores pixels, axis and symmetry in gesture order; overlay re-syncs', () => {
  const a = boot();
  draw(a.canvas, 1, 1);
  a.doc.symButtons[2].onclick();
  const g = a.els.gripV;
  g.dispatch('pointerdown', gripEv(160, 160));
  g.dispatch('pointermove', gripEv(90, 160)); // -> 4.5
  g.dispatch('pointerup', gripEv(90, 160));

  a.els.undo.onclick();
  assert.strictEqual(saved(a).axisV, 8);
  assert.strictEqual(saved(a).symmetry, 'vertical');
  assert.strictEqual(saved(a).frames[0][1 * 16 + 1], '#ff7aa8');
  assert.strictEqual(a.els.gripV.style.left, '50%');

  a.els.undo.onclick();
  assert.strictEqual(saved(a).symmetry, 'off');
  assert.strictEqual(saved(a).frames[0][1 * 16 + 1], '#ff7aa8');

  a.els.undo.onclick();
  assert.strictEqual(saved(a).frames[0][1 * 16 + 1], '');

  a.els.redo.onclick();
  assert.strictEqual(saved(a).frames[0][1 * 16 + 1], '#ff7aa8');
});

test('new edit after undo clears redo', () => {
  const a = boot();
  draw(a.canvas, 1, 1);
  a.els.undo.onclick();
  draw(a.canvas, 2, 2);
  a.els.redo.onclick();
  assert.strictEqual(saved(a).frames[0][1 * 16 + 1], '');
  assert.strictEqual(saved(a).frames[0][2 * 16 + 2], '#ff7aa8');
});

test('frame switching and playback stay aligned with pixels', () => {
  const a = boot();
  draw(a.canvas, 0, 0);
  a.els.addFrame.onclick();
  assert.strictEqual(saved(a).frames.length, 2);
  assert.strictEqual(saved(a).current, 1);
  assert.strictEqual(a.els.frames.children.length, 2);
  a.els.frames.children[0].onclick();
  assert.strictEqual(saved(a).current, 0);
  a.els.play.onclick();
  const t = a.timers.find(x => x && x.type === 'i');
  t.fn(); assert.strictEqual(saved(a).current, 1);
  t.fn(); assert.strictEqual(saved(a).current, 0);
  a.els.play.onclick();
});

test('undo after frame adds removes frames and clamps current', () => {
  const a = boot();
  a.els.addFrame.onclick();
  a.els.addFrame.onclick();
  a.els.undo.onclick();
  assert.strictEqual(saved(a).frames.length, 2);
  a.els.undo.onclick();
  assert.strictEqual(saved(a).frames.length, 1);
});

test('refresh (reboot from same storage) restores pixels, axes and wrap', () => {
  const a1 = boot();
  a1.doc.symButtons[3].onclick();
  a1.els.wrap.checked = true;
  a1.els.wrap.onchange({ target: { checked: true } });
  draw(a1.canvas, 7, 7);
  a1.els.save.onclick();

  const a2 = boot({
    _data: { pixelLoom: a1.storage._data.pixelLoom },
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); }
  });
  assert.strictEqual(a2.els.wrap.checked, true);
  assert.notStrictEqual(a2.els.axisV.style.display, 'none');
  assert.notStrictEqual(a2.els.axisH.style.display, 'none');
  assert.strictEqual(a2.els.wrapbadge.style.display, 'block');
  assert.ok(a2.doc.symButtons[3].classList.contains('active'));
  assert.strictEqual(saved(a2).frames[0][7 * 16 + 7], '#ff7aa8');
});

test('gesture that changes nothing leaves no undo entry', () => {
  const a = boot();
  draw(a.canvas, 3, 3);
  draw(a.canvas, 3, 3); // same color on same cell: no-op gesture
  a.els.undo.onclick();
  assert.strictEqual(saved(a).frames[0][3 * 16 + 3], ''); // one undo clears it
});

test('no-op fill leaves no undo entry', () => {
  const a = boot();
  draw(a.canvas, 0, 0);
  a.doc.toolButtons[2].onclick(); // fill with pencil color on... paint full sheet first
  a.canvas.dispatch('pointerdown', cellEvent(0, 0));
  // fill again with the same color anywhere: no-op
  a.canvas.dispatch('pointerdown', cellEvent(5, 5));
  a.doc.toolButtons[0].onclick(); // pencil
  a.els.undo.onclick();           // undoes the full-sheet fill only
  const f = saved(a).frames[0];
  assert.strictEqual(f[0], '#ff7aa8'); // original pixel survived
  assert.strictEqual(f[5 * 16 + 5], '');
});

test('keyboard Ctrl+Z / Ctrl+Shift+Z drive undo/redo', () => {
  const a = boot();
  draw(a.canvas, 1, 1);
  const ev = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, preventDefault() {} };
  a.doc.dispatchDoc('keydown', ev);
  assert.strictEqual(saved(a).frames[0][17], '');
  a.doc.dispatchDoc('keydown', Object.assign({}, ev, { shiftKey: true }));
  assert.strictEqual(saved(a).frames[0][17], '#ff7aa8');
});

test('export downloads the 16x16 bitmap (no axis/grid overlay)', () => {
  const a = boot();
  draw(a.canvas, 1, 1);
  let downloaded = null;
  const orig = a.doc.createElement;
  a.doc.createElement = function (tag) {
    const el = orig.call(this, tag);
    if (tag === 'a') downloaded = el;
    return el;
  };
  a.els.export.onclick();
  assert.ok(downloaded);
  assert.strictEqual(downloaded.href, 'data:image/png;base64,STUB');
  assert.strictEqual(downloaded.download, 'pixel-loom-frame.png');
});

console.log(`\n${passed} e2e tests passed`);
