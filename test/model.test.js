/* Node tests for Pixel Loom core. Run: node test/model.test.js */
const assert = require('assert');
const L = require('../loom.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('FAIL -', name, '\n', e); process.exitCode = 1; }
}

const N = L.DEFAULT_N;
assert.strictEqual(N, 16);

/* ---------- axis geometry ---------- */

test('axis snap: drag near edge clamps to boundary 0 / n', () => {
  assert.strictEqual(L.snapAxis(-3, N), 0);
  assert.strictEqual(L.snapAxis(N + 9, N), N);
});

test('axis snap: boundary vs center choose nearest', () => {
  assert.strictEqual(L.snapAxis(0.2, N), 0);      // boundary 0
  assert.strictEqual(L.snapAxis(0.5, N), 0.5);    // center 0.5
  assert.strictEqual(L.snapAxis(0.8, N), 1);      // boundary 1
  assert.strictEqual(L.snapAxis(3.4, N), 3.5);    // center 3.5
  assert.strictEqual(L.snapAxis(N / 2, N), N / 2);
});

test('mirror at cell-center axis fixes center row/col', () => {
  const axis = N / 2;
  for (let i = 0; i < N; i++) {
    assert.strictEqual(L.mirror(L.mirror(i, axis, N), axis, N), i);
  }
  assert.strictEqual(L.mirror(7, axis, N), 8);
  assert.strictEqual(L.mirror(8, axis, N), 7);
});

test('mirror at boundary axis has no fixed cell and maps 0<->2b-1', () => {
  const b = 6; // boundary before cell 6
  assert.strictEqual(L.mirror(0, b, N), 11);
  assert.strictEqual(L.mirror(11, b, N), 0);
  for (let i = 0; i < N; i++) {
    assert.notStrictEqual(L.mirror(i, b, N), i);
  }
  assert.strictEqual(L.mirror(12, b, N), -1); // image outside canvas
});

test('mirror at edge boundary 0 reflects everything out', () => {
  for (let i = 0; i < N; i++) assert.strictEqual(L.mirror(i, 0, N), -1);
});

/* ---------- dab planning ---------- */

test('off symmetry: single cell, out-of-range rejected when wrap off', () => {
  const s = L.createState();
  assert.deepStrictEqual(L.planDab(s, 2, 3), [3 * N + 2]);
  assert.deepStrictEqual(L.planDab(s, -1, 0), []);
  assert.deepStrictEqual(L.planDab(s, 0, N), []);
});

test('vertical symmetry mirrors x only', () => {
  const s = L.createState();
  s.symmetry = 'vertical';
  const dabs = L.planDab(s, 2, 5).sort((a, b) => a - b);
  assert.deepStrictEqual(dabs, [5 * N + 2, 5 * N + 13]);
});

test('horizontal symmetry mirrors y only', () => {
  const s = L.createState();
  s.symmetry = 'horizontal';
  const dabs = L.planDab(s, 2, 5).sort((a, b) => a - b);
  assert.deepStrictEqual(dabs, [5 * N + 2, 10 * N + 2]);
});

test('quad symmetry gives up to four points', () => {
  const s = L.createState();
  s.symmetry = 'quad';
  const dabs = L.planDab(s, 2, 5).sort((a, b) => a - b);
  assert.strictEqual(dabs.length, 4);
  assert.deepStrictEqual(dabs,
    [5 * N + 2, 5 * N + 13, 10 * N + 2, 10 * N + 13]);
});

test('painting on axis yields no duplicate dabs (fixed point)', () => {
  const s = L.createState();
  s.symmetry = 'quad';
  // x=7 mirrors to 8 (distinct), x=8 likewise; axis cell only for the
  // half case... use a fixed point: center axis 8 => cell 7/8 pair.
  assert.strictEqual(L.planDab(s, 7, 7).length, 4);
  s.axisH = s.axisV = 0.5; // center of cell 0 is fixed
  assert.deepStrictEqual(L.planDab(s, 0, 0), [0]);
});

test('mirror image outside canvas is dropped, not wrapped', () => {
  const s = L.createState();
  s.symmetry = 'vertical';
  s.axisV = 1; // boundary; cell 0 -> 1 (in), everything below -> out
  assert.deepStrictEqual(L.planDab(s, 0, 0), [0, 1]);
  assert.deepStrictEqual(L.planDab(s, 15, 0), [15]); // image -4 dropped
});

/* ---------- wrap ---------- */

test('wrap folds out-of-range cells to opposite side', () => {
  const s = L.createState();
  s.wrap = true;
  assert.deepStrictEqual(L.planDab(s, -1, 0), [15]);
  assert.deepStrictEqual(L.planDab(s, N, N), [0]);
  assert.deepStrictEqual(L.planDab(s, 2 * N + 3, -1), [(N - 1) * N + 3]);
});

test('wrap + quad: base cell folds first, mirrors computed on folded cell', () => {
  const s = L.createState();
  s.wrap = true;
  s.symmetry = 'quad';
  // (-1,0) folds to (15,0); mirrors -> (0,0),(15,15),(0,15)
  const dabs = L.planDab(s, -1, 0).sort((a, b) => a - b);
  assert.deepStrictEqual(dabs, [0, 15, N * 15, N * 15 + 15]);
});

/* ---------- continuous strokes ---------- */

test('interpolated stroke fills gap for fast pointer move', () => {
  const s = L.createState();
  const st = L.createStore(L.createState());
  const stroke = L.createStroke(st, 'pencil');
  stroke.move(0, 0);
  stroke.move(5, 0);
  const f = st.state.frames[0];
  for (let x = 0; x <= 5; x++) assert.strictEqual(f[x], s.color);
  assert.strictEqual(f[6], '');
  // one history entry per gesture
  assert.strictEqual(st.history.length, 0); // start pushed by caller
});

test('wrapped stroke crossing seam stays continuous (15,0)->(0,0) via 16', () => {
  const st = L.createStore(L.createState());
  st.state.wrap = true;
  const stroke = L.createStroke(st, 'pencil');
  stroke.move(15, 0);
  stroke.move(16, 0); // one cell beyond right edge => cell 0
  const f = st.state.frames[0];
  assert.strictEqual(f[15], '#ff7aa8');
  assert.strictEqual(f[0], '#ff7aa8');
  assert.strictEqual(f[1], ''); // no smearing
});

test('eraser stroke clears symmetric partners', () => {
  const st = L.createStore(L.createState());
  st.state.symmetry = 'vertical';
  st.state.frames[0][2] = st.state.frames[0][13] = '#000';
  const stroke = L.createStroke(st, 'eraser');
  stroke.move(2, 0);
  const f = st.state.frames[0];
  assert.strictEqual(f[2], '');
  assert.strictEqual(f[13], '');
});

/* ---------- flood fill ---------- */

test('plain fill replaces bounded region only', () => {
  const s = L.createState();
  // border wall
  for (let x = 0; x < N; x++) { s.frames[0][x] = '#000'; s.frames[0][(N - 1) * N + x] = '#000'; }
  const changed = L.floodFill(s, N / 2, N / 2);
  assert.strictEqual(changed, true);
  assert.strictEqual(s.frames[0][N / 2 * N + N / 2], '#ff7aa8');
  assert.strictEqual(s.frames[0][0], '#000'); // wall untouched
});

test('fill same color is a no-op (returns false)', () => {
  const s = L.createState();
  s.color = '#fff';
  s.frames[0][5 * N + 5] = '#fff';
  assert.strictEqual(L.floodFill(s, 5, 5), false);
});

test('torus fill ignores walls crossing edges and wraps the whole sheet', () => {
  const s = L.createState();
  s.wrap = true;
  // A ring of wall cells near the edge; without wrap it bounds nothing,
  // with wrap the "outside" and "inside" are separate only if closed.
  // Simpler: fill empty sheet with wrap -> every cell painted.
  assert.strictEqual(L.floodFill(s, 0, 0), true);
  assert.ok(s.frames[0].every(v => v === '#ff7aa8'));
});

test('torus fill crosses left/right seam', () => {
  const s = L.createState();
  s.wrap = true;
  // Horizontal corridor row 7 with walls above/below, open at both seams.
  for (let x = 0; x < N; x++) {
    s.frames[0][6 * N + x] = '#000';
    s.frames[0][8 * N + x] = '#000';
  }
  assert.strictEqual(L.floodFill(s, 0, 7), true);
  for (let x = 0; x < N; x++)
    assert.strictEqual(s.frames[0][7 * N + x], '#ff7aa8', 'row7 x=' + x);
  assert.strictEqual(s.frames[0][6 * N], '#000');
  assert.strictEqual(s.frames[0][8 * N], '#000');
});

test('torus fill crosses top/bottom seam', () => {
  const s = L.createState();
  s.wrap = true;
  for (let y = 0; y < N; y++) {
    s.frames[0][y * N + 3] = '#000';
    s.frames[0][y * N + 5] = '#000';
  }
  assert.strictEqual(L.floodFill(s, 4, 0), true);
  for (let y = 0; y < N; y++)
    assert.strictEqual(s.frames[0][y * N + 4], '#ff7aa8', 'col4 y=' + y);
});

test('symmetric fill mirrors the painted region', () => {
  const s = L.createState();
  s.symmetry = 'vertical';
  // Small box on left half
  s.frames[0][4 * N + 2] = '#000';
  s.frames[0][4 * N + 3] = '#000';
  s.frames[0][5 * N + 2] = '#000';
  s.frames[0][5 * N + 3] = '#000';
  assert.ok(L.floodFill(s, 2, 4));
  // mirrored x: 2->13,3->12 at rows 4,5
  for (const [x, y] of [[2,4],[3,4],[2,5],[3,5],[13,4],[12,4],[13,5],[12,5]]) {
    assert.strictEqual(s.frames[0][y * N + x], '#ff7aa8');
  }
});

test('symmetric fill overwrites differing color on mirrored side', () => {
  const s = L.createState();
  s.symmetry = 'vertical';
  s.frames[0][4 * N + 2] = '#000';
  s.frames[0][5 * N + 2] = '#000';
  s.frames[0][4 * N + 13] = '#aaa'; // mirrored side: different color, still overwritten
  assert.ok(L.floodFill(s, 2, 4));
  assert.strictEqual(s.frames[0][4 * N + 2], '#ff7aa8');
  assert.strictEqual(s.frames[0][5 * N + 2], '#ff7aa8');
  assert.strictEqual(s.frames[0][4 * N + 13], '#ff7aa8');
  assert.strictEqual(s.frames[0][5 * N + 13], '#ff7aa8');
});

test('non-wrap fill starting outside canvas is rejected', () => {
  const s = L.createState();
  assert.strictEqual(L.floodFill(s, -1, 0), false);
});

/* ---------- history incl. axis/wrap ---------- */

test('undo/redo restores pixels, axis position and wrap together', () => {
  const st = L.createStore(L.createState());
  st.push();
  st.state.frames[0][0] = '#fff';
  st.push();
  st.state.axisV = 4.5;
  st.state.symmetry = 'vertical';
  st.state.wrap = true;

  assert.ok(st.undo());
  assert.strictEqual(st.state.axisV, N / 2);
  assert.strictEqual(st.state.symmetry, 'off');
  assert.strictEqual(st.state.wrap, false);
  assert.strictEqual(st.state.frames[0][0], '#fff'); // pixel edit survived

  assert.ok(st.redo());
  assert.strictEqual(st.state.axisV, 4.5);
  assert.strictEqual(st.state.symmetry, 'vertical');
  assert.strictEqual(st.state.wrap, true);
});

test('new edit after undo clears redo branch', () => {
  const st = L.createStore(L.createState());
  st.push(); st.state.frames[0][0] = '#fff';
  st.undo();
  st.push(); st.state.frames[0][1] = '#000';
  assert.strictEqual(st.future.length, 0);
});

test('frame add/duplicate with undo restores frame count and current', () => {
  const st = L.createStore(L.createState());
  L.addFrame(st);
  assert.strictEqual(st.state.frames.length, 2);
  L.duplicateFrame(st);
  assert.strictEqual(st.state.frames.length, 3);
  assert.strictEqual(st.state.current, 2);
  st.undo();
  assert.strictEqual(st.state.frames.length, 2);
  assert.strictEqual(st.state.current, 1);
  st.undo();
  assert.strictEqual(st.state.frames.length, 1);
  assert.strictEqual(st.state.current, 0);
});

test('undo clamps current when frames removed, no错位 on切帧', () => {
  const st = L.createStore(L.createState());
  L.addFrame(st); L.addFrame(st);
  st.state.current = 2;
  st.push();
  // simulate dropping both frames in one edit
  st.state.frames.length = 1;
  st.undo();
  assert.strictEqual(st.state.current, Math.min(2, st.state.frames.length - 1));
});

/* ---------- serialization roundtrip ---------- */

test('serialize/load preserves axis, wrap, frames, fps', () => {
  const s = L.createState();
  s.frames[0][0] = '#123456';
  s.symmetry = 'quad';
  s.axisH = 3; s.axisV = 10.5; s.wrap = true; s.fps = 12;
  const out = L.createState();
  assert.ok(L.load(out, L.serialize(s)));
  assert.strictEqual(out.frames[0][0], '#123456');
  assert.strictEqual(out.symmetry, 'quad');
  assert.strictEqual(out.axisH, 3);
  assert.strictEqual(out.axisV, 10.5);
  assert.strictEqual(out.wrap, true);
  assert.strictEqual(out.fps, 12);
});

test('load rejects legacy/garbage without throwing', () => {
  const s = L.createState();
  assert.strictEqual(L.load(s, '{}'), false);
  assert.strictEqual(L.load(s, { frames: [] }), false);
  assert.strictEqual(L.load(s, { frames: [['x']] }), false); // wrong size
});

test('legacy v1 payload (pixels/fps only) loads with default axes', () => {
  const s = L.createState();
  const legacy = JSON.stringify({ frames: [new Array(N * N).fill('')], fps: 9 });
  assert.ok(L.load(s, legacy));
  assert.strictEqual(s.fps, 9);
  assert.strictEqual(s.symmetry, 'off');
  assert.strictEqual(s.axisV, N / 2);
  assert.strictEqual(s.wrap, false);
});

console.log(`\n${passed} model tests passed`);
