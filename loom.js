/* Pixel Loom core: symmetry axes, edge wrap, flood fill, unified undo/redo.
   Pure model + geometry, no DOM. Cell coords are integers in [0,N); axes use
   cell units where integers are cell boundaries and k+.5 are cell centers. */
(function (global) {
  'use strict';

  var DEFAULT_N = 16;

  function createState(n) {
    n = n || DEFAULT_N;
    return {
      n: n,
      frames: [new Array(n * n).fill('')],
      current: 0,
      tool: 'pencil',
      color: '#ff7aa8',
      symmetry: 'off',       // off | horizontal | vertical | quad
      axisH: n / 2,          // horizontal axis position (y units): reflects y
      axisV: n / 2,          // vertical axis position (x units): reflects x
      wrap: false,
      fps: 8,
      onion: false,
      opacity: 23,
      zoom: 20
    };
  }

  /* ---- snapshot / history ---- */

  function snapshot(s) {
    return {
      frames: s.frames.map(function (f) { return f.slice(); }),
      current: s.current,
      symmetry: s.symmetry,
      axisH: s.axisH,
      axisV: s.axisV,
      wrap: s.wrap
    };
  }

  function createStore(state, limit) {
    var store = { state: state, history: [], future: [], limit: limit || 50 };
    store.push = function () {
      store.history.push(snapshot(state));
      if (store.history.length > store.limit) store.history.shift();
      store.future.length = 0;
    };
    store.undo = function () {
      if (!store.history.length) return false;
      store.future.push(snapshot(state));
      restore(state, store.history.pop());
      return true;
    };
    store.redo = function () {
      if (!store.future.length) return false;
      store.history.push(snapshot(state));
      restore(state, store.future.pop());
      return true;
    };
    store.reset = function () {
      store.history.length = 0;
      store.future.length = 0;
    };
    // Capture a potential undo point; commit it only if the edit mutated
    // anything, so no-op gestures neither clear redo nor pollute history.
    store.checkpoint = function () { return snapshot(state); };
    store.commit = function (snap) {
      store.history.push(snap);
      if (store.history.length > store.limit) store.history.shift();
      store.future.length = 0;
    };
    return store;
  }

  function restore(s, p) {
    s.frames = p.frames.map(function (f) { return f.slice(); });
    s.current = Math.min(p.current, s.frames.length - 1);
    s.symmetry = p.symmetry;
    s.axisH = p.axisH;
    s.axisV = p.axisV;
    s.wrap = p.wrap;
  }

  /* ---- axis geometry ----
     Snap a free drag position (cell units) to the nearest allowed axis:
     cell centers (k + 0.5) or cell boundaries (k). */

  function snapAxis(v, n) {
    v = Math.max(0, Math.min(n, v));
    var half = Math.round(v - 0.5) + 0.5;   // nearest center
    var boundary = Math.round(v);           // nearest boundary
    var pick = Math.abs(v - half) <= Math.abs(v - boundary) ? half : boundary;
    return Math.max(0, Math.min(n, pick));
  }

  // Reflect a cell index across an axis expressed in cell units.
  function mirror(i, axis, n) {
    var m = Math.round(2 * axis) - 1 - i;
    if (m < 0 || m >= n) return -1;
    return m;
  }

  // Wrap a (possibly out-of-range) cell coordinate into [0,n).
  function wrapCell(i, n) {
    return ((i % n) + n) % n;
  }

  /* ---- dab planning ----
     Returns the set of frame-pixel indices a single touch must land on,
     applying symmetry and edge wrap. Base coords are pre-wrap pointer cells. */

  function planDab(s, bx, by) {
    var n = s.n, out = [], seen = {};
    var xs = [bx], ys = [by];

    if (s.wrap) {
      bx = wrapCell(bx, n);
      by = wrapCell(by, n);
      xs = [bx];
      ys = [by];
    } else if (bx < 0 || bx >= n || by < 0 || by >= n) {
      return out;
    }

    if (s.symmetry === 'horizontal' || s.symmetry === 'quad') {
      var my = mirror(by, s.axisH, n);
      if (my >= 0 && ys.indexOf(my) < 0) ys.push(my);
    }
    if (s.symmetry === 'vertical' || s.symmetry === 'quad') {
      var mx = mirror(bx, s.axisV, n);
      if (mx >= 0 && xs.indexOf(mx) < 0) xs.push(mx);
    }

    for (var yi = 0; yi < ys.length; yi++) {
      for (var xi = 0; xi < xs.length; xi++) {
        var x = xs[xi], y = ys[yi];
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        var idx = y * n + x;
        if (!seen[idx]) { seen[idx] = 1; out.push(idx); }
      }
    }
    return out;
  }

  function applyDab(s, indices, erase) {
    var f = s.frames[s.current], v = erase ? '' : s.color, changed = false;
    for (var k = 0; k < indices.length; k++) {
      if (f[indices[k]] !== v) { f[indices[k]] = v; changed = true; }
    }
    return changed;
  }

  /* ---- strokes with continuous interpolation ----
     Coordinates live in "virtual" space that is never folded: crossing an
     edge while wrapped keeps growing (320..336) so the interpolated line is
     continuous; folding to cells happens per dab. */

  function createStroke(store, tool) {
    var s = store.state;
    return {
      tool: tool,
      last: null,
      // returns true when pixels changed
      move: function (vx, vy) {
        var pts = this.last === null
          ? [[vx, vy]]
          : lineCells(this.last[0], this.last[1], vx, vy);
        var changed = false;
        for (var i = 0; i < pts.length; i++) {
          var ix = pts[i][0], iy = pts[i][1];
          if (!s.wrap && (ix < 0 || ix >= s.n || iy < 0 || iy >= s.n)) continue;
          var dab = planDab(s, ix, iy);
          if (applyDab(s, dab, this.tool === 'eraser')) changed = true;
        }
        this.last = [vx, vy];
        return changed;
      }
    };
  }

  // Integer cells intersected by segment a->b (supercover-ish, axis steps).
  function lineCells(x0, y0, x1, y1) {
    var out = [];
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy, x = x0, y = y0, guard = 0;
    while (guard++ < 1024) {
      out.push([x, y]);
      if (x === x1 && y === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return out;
  }

  /* ---- flood fill (torus-aware, symmetry-aware) ---- */

  function floodFill(s, sx, sy) {
    var n = s.n;
    if (!s.wrap && (sx < 0 || sx >= n || sy < 0 || sy >= n)) return false;
    sx = wrapCell(sx, n); sy = wrapCell(sy, n);

    var f = s.frames[s.current];
    var target = f[sy * n + sx];
    var replacement = s.tool === 'eraser' ? '' : s.color;
    if (target === replacement) return false;

    // Flood once from the actual click (torus-aware when wrapped), then map
    // every reached cell through the symmetry mirrors: landing points behave
    // exactly like pencil dabs and overwrite whatever sits across the axis.
    var seen = {};
    var queue = [sx + sy * n];
    seen[queue[0]] = 1;
    var region = [];
    while (queue.length) {
      var idx = queue.pop();
      region.push(idx);
      var x = idx % n, y = (idx - x) / n;
      var neigh = s.wrap
        ? [wrapCell(x + 1, n) + y * n, wrapCell(x - 1, n) + y * n,
           x + wrapCell(y + 1, n) * n, x + wrapCell(y - 1, n) * n]
        : [x + 1 + y * n, x - 1 + y * n, x + (y + 1) * n, x + (y - 1) * n];
      for (var k = 0; k < 4; k++) {
        var ni = neigh[k];
        if (ni < 0 || ni >= n * n || seen[ni]) continue;
        if (!s.wrap) {
          var nx = ni % n, ny = (ni - nx) / n;
          if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        }
        if (f[ni] !== target) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }

    var paint = {}, changed = false;
    for (var r = 0; r < region.length; r++) {
      var cx = region[r] % n, cy = (region[r] - cx) / n;
      var dabs = planDab(s, cx, cy);
      for (var dI = 0; dI < dabs.length; dI++) {
        if (!paint[dabs[dI]]) {
          paint[dabs[dI]] = 1;
          if (f[dabs[dI]] !== replacement) { f[dabs[dI]] = replacement; changed = true; }
        }
      }
    }
    return changed;
  }

  /* ---- frames ---- */

  function addFrame(store) {
    store.push();
    var s = store.state;
    s.frames.push(new Array(s.n * s.n).fill(''));
    s.current = s.frames.length - 1;
  }

  function duplicateFrame(store) {
    store.push();
    var s = store.state;
    s.frames.splice(s.current + 1, 0, s.frames[s.current].slice());
    s.current++;
  }

  /* ---- serialization ---- */

  function serialize(s) {
    return JSON.stringify({
      v: 2,
      n: s.n,
      frames: s.frames,
      current: s.current,
      fps: s.fps,
      symmetry: s.symmetry,
      axisH: s.axisH,
      axisV: s.axisV,
      wrap: s.wrap
    });
  }

  function load(s, data) {
    var d = typeof data === 'string' ? JSON.parse(data) : data;
    if (!d || !Array.isArray(d.frames) || !d.frames.length) return false;
    var n = d.n || s.n;
    var size = n * n;
    s.n = n;
    s.frames = d.frames
      .filter(function (f) { return Array.isArray(f) && f.length === size; })
      .map(function (f) { return f.slice(); });
    if (!s.frames.length) return false;
    s.current = Math.max(0, Math.min(d.current | 0 || 0, s.frames.length - 1));
    s.fps = d.fps || 8;
    s.symmetry = ['off', 'horizontal', 'vertical', 'quad'].indexOf(d.symmetry) >= 0
      ? d.symmetry : 'off';
    s.axisH = typeof d.axisH === 'number' ? d.axisH : n / 2;
    s.axisV = typeof d.axisV === 'number' ? d.axisV : n / 2;
    s.wrap = !!d.wrap;
    return true;
  }

  global.PixelLoom = {
    DEFAULT_N: DEFAULT_N,
    createState: createState,
    createStore: createStore,
    snapshot: snapshot,
    restore: restore,
    snapAxis: snapAxis,
    mirror: mirror,
    wrapCell: wrapCell,
    planDab: planDab,
    applyDab: applyDab,
    createStroke: createStroke,
    lineCells: lineCells,
    floodFill: floodFill,
    addFrame: addFrame,
    duplicateFrame: duplicateFrame,
    serialize: serialize,
    load: load
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.PixelLoom;
})(typeof window !== 'undefined' ? window : globalThis);
