/* ===== Figma-style canvas engine: pan / zoom / layers / inspector / pins / minimap / play ===== */
window.Fig = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const vp = document.getElementById('viewport');
  const world = document.getElementById('world');
  const zoomLbl = document.getElementById('zoomLbl');
  const layers = document.getElementById('layerList');
  const insp = document.getElementById('inspector');
  const mini = document.getElementById('minimap');
  const NOTES = window.FIG_NOTES || {};
  const SPONSOR = window.FIG_SPONSORS || {};
  const players = {};          // frameName -> fn(frame) => cleanup
  let cleanups = [];
  let x = 40, y = 40, s = 0.3, playing = false, selected = null, spaceDown = false;
  const frames = [...world.querySelectorAll('.frame')];
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ---------- transform ---------- */
  function apply(anim) {
    const t = anim ? '.55s cubic-bezier(.2,.8,.2,1)' : '0s';
    world.style.transition = 'transform ' + t;
    vp.style.transition = 'background-position ' + t + ', background-size ' + t;
    world.style.transform = `translate(${x}px,${y}px) scale(${s})`;
    world.style.setProperty('--inv', 1 / s);
    const g = 24 * s;
    vp.style.backgroundSize = `${g}px ${g}px`;
    vp.style.backgroundPosition = `${x}px ${y}px`;
    zoomLbl.textContent = Math.round(s * 100) + '%';
    drawMini();
  }
  function zoomAt(px, py, ns, anim) {
    ns = Math.min(4, Math.max(0.04, ns));
    x = px - (px - x) * (ns / s);
    y = py - (py - y) * (ns / s);
    s = ns;
    apply(anim);
  }
  function fit(r, anim = true, pad = 60) {
    const w = vp.clientWidth, h = vp.clientHeight;
    s = Math.min(4, Math.min((w - pad * 2) / r.w, (h - pad * 2) / r.h));
    x = (w - r.w * s) / 2 - r.x * s;
    y = (h - r.h * s) / 2 - r.y * s;
    apply(anim);
  }
  const frameRect = (f) => ({ x: f.offsetLeft, y: f.offsetTop, w: f.offsetWidth, h: f.offsetHeight });
  function worldBounds() {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    frames.forEach((f) => { const r = frameRect(f); a = Math.min(a, r.x); b = Math.min(b, r.y); c = Math.max(c, r.x + r.w); d = Math.max(d, r.y + r.h); });
    return { x: a, y: b - 40, w: c - a, h: d - b + 40 };
  }
  // element rect in world units, independent of current zoom
  function relRect(el, to = world) {
    const r = el.getBoundingClientRect(), w = to.getBoundingClientRect();
    return { x: (r.left - w.left) / s, y: (r.top - w.top) / s, w: r.width / s, h: r.height / s };
  }
  const fitAll = () => fit(worldBounds());
  const zoomToFrame = (f) => fit(frameRect(f), true, 40);

  /* ---------- frame labels ---------- */
  frames.forEach((f) => {
    const l = document.createElement('div');
    l.className = 'frame-label';
    l.textContent = f.dataset.name;
    l.style.left = f.offsetLeft + 'px';
    l.style.top = f.offsetTop + 'px';
    l.style.transform = 'translateY(calc(-100% - 6px * var(--inv)))';
    l.addEventListener('pointerup', (e) => { e.stopPropagation(); select(f); zoomToFrame(f); });
    f._label = l;
    world.appendChild(l);
  });

  /* ---------- selection ---------- */
  const box = document.createElement('div');
  box.className = 'selbox';
  box.innerHTML = '<i></i><i></i><i></i><i></i><b></b>';
  world.appendChild(box);

  function select(el) {
    selected = el;
    document.querySelectorAll('.frame-label.on,.ly-row.on').forEach((n) => n.classList.remove('on'));
    if (!el) { box.classList.remove('show'); renderInspector(null); return; }
    const r = relRect(el);
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    box.querySelector('b').textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    box.classList.add('show');
    const frame = el.closest('.frame');
    frame?._label?.classList.add('on');
    el._row?.classList.add('on');
    if (frame?._row && !frame._kids.classList.contains('open')) toggleKids(frame, true);
    renderInspector(el);
  }

  function renderInspector(el) {
    if (!el) {
      insp.innerHTML = `<div class="pan-h">Design</div>
        <div class="ins-empty">Click any frame or layer to see its specs, design notes and which sponsor powers it.</div>
        <div class="ins-sec"><h5>Shortcuts</h5><div class="kbd">
        <kbd>Drag</kbd><span>Pan canvas</span><kbd>Wheel</kbd><span>Zoom (trackpad: pinch)</span>
        <kbd>1</kbd><span>Zoom to fit all</span><kbd>2</kbd><span>Zoom to selection</span>
        <kbd>← →</kbd><span>Previous / next frame</span><kbd>P</kbd><span>Play animations</span>
        <kbd>C</kbd><span>Toggle comments</span><kbd>Esc</kbd><span>Deselect</span></div></div>`;
      return;
    }
    const isFrame = el.classList.contains('frame');
    const name = isFrame ? el.dataset.name : el.dataset.spec;
    const frame = el.closest('.frame');
    const r = relRect(el, isFrame ? world : frame);
    const note = NOTES[name] || (el.dataset.note ? `<p>${esc(el.dataset.note)}</p>` : '');
    const sponsors = (el.dataset.sponsor || '').split(',').filter(Boolean);
    const tokens = (el.dataset.tokens || '').split(',').filter(Boolean);
    insp.innerHTML = `
      <div class="ins-sec"><div class="ins-name">${esc(name)}</div>
        <div class="ins-type">${isFrame ? 'Frame' : (el.dataset.kind || 'Component')}${isFrame ? '' : ' · in ' + esc(frame.dataset.name)}</div></div>
      <div class="ins-sec"><h5>Layout</h5><div class="ins-grid">
        <div><span>X</span>${Math.round(r.x)}</div><div><span>Y</span>${Math.round(r.y)}</div>
        <div><span>W</span>${Math.round(r.w)}</div><div><span>H</span>${Math.round(r.h)}</div></div></div>
      ${sponsors.length ? `<div class="ins-sec"><h5>Powered by</h5>${sponsors.map((k) => {
        const sp = SPONSOR[k] || { name: k, c: '#888' };
        return `<a class="ins-chip" style="background:${sp.c}" href="${sp.url || '#'}" target="_blank" rel="noopener">${esc(sp.name)} ↗</a>`;
      }).join('')}</div>` : ''}
      ${note ? `<div class="ins-sec"><h5>Design notes</h5><div class="ins-notes">${note}</div></div>` : ''}
      ${tokens.length ? `<div class="ins-sec"><h5>Tokens</h5>${tokens.map((t) => {
        const [n, v] = t.split(':');
        return `<div class="ins-sw"><i style="background:${v}"></i>${esc(n)} <span style="color:var(--chrome-muted)">${esc(v)}</span></div>`;
      }).join('')}</div>` : ''}`;
  }

  /* ---------- layers panel ---------- */
  function toggleKids(f, open) {
    f._kids.classList.toggle('open', open);
    f._row.classList.toggle('open', open);
  }
  frames.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'ly-row';
    row.innerHTML = `<span class="car">▶</span><span class="ic">#</span>${esc(f.dataset.name)}`;
    const kids = document.createElement('div');
    kids.className = 'ly-kids';
    const seen = new Set();
    f.querySelectorAll('[data-spec]').forEach((el) => {
      if (seen.has(el.dataset.spec)) return;
      seen.add(el.dataset.spec);
      const k = document.createElement('div');
      k.className = 'ly-row';
      k.innerHTML = `<span class="ic">${el.dataset.kind === 'Text' ? 'T' : '◇'}</span>${esc(el.dataset.spec)}`;
      k.onclick = () => { select(el); const r = relRect(el); fit({ x: r.x - 200, y: r.y - 150, w: r.w + 400, h: r.h + 300 }); };
      el._row = k;
      kids.appendChild(k);
    });
    row.onclick = (e) => {
      if (e.target.classList.contains('car')) return toggleKids(f, !kids.classList.contains('open'));
      select(f); zoomToFrame(f);
    };
    f._row = row; f._kids = kids;
    layers.append(row, kids);
  });

  /* ---------- pins ---------- */
  document.querySelectorAll('[data-pin]').forEach((el, i) => {
    const p = document.createElement('div');
    p.className = 'pin';
    p.innerHTML = `${i + 1}<span>${esc(el.dataset.pin)}</span>`;
    const frame = el.closest('.frame');
    const r = relRect(el, frame);
    p.style.left = (r.x + r.w - 6) + 'px';
    p.style.top = (r.y + 6) + 'px';
    frame.appendChild(p);
  });

  /* ---------- input: pan / zoom / click ---------- */
  let drag = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.button > 1) return;
    drag = { cx: e.clientX, cy: e.clientY, x, y, moved: false, target: e.target };
    if (spaceDown || e.button === 1) drag.moved = true, vp.classList.add('panning');
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; vp.classList.add('panning'); }
    if (drag.moved) { x = drag.x + dx; y = drag.y + dy; apply(false); }
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag; drag = null;
    vp.classList.remove('panning');
    if (d.moved) return;
    if (d.target.closest('.pin,.frame-label,#minimap')) return;
    const hit = d.target.closest('[data-spec]') || d.target.closest('.frame');
    select(world.contains(hit) ? hit : null);
  });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    const mouseLike = Math.abs(e.deltaY) >= 40 && e.deltaX === 0;
    if (e.ctrlKey || e.metaKey || mouseLike) zoomAt(e.clientX - r.left, e.clientY - r.top, s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), false);
    else { x -= e.deltaX; y -= e.deltaY; apply(false); }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea')) return;
    if (e.code === 'Space') { spaceDown = true; vp.classList.add('space'); e.preventDefault(); }
    if (e.key === '1') fitAll();
    if (e.key === '2' && selected) { const r = relRect(selected); fit(r, true, 40); }
    if (e.key === '0') zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1, true);
    if (e.key === '=' || e.key === '+') zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, s * 1.25, true);
    if (e.key === '-') zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, s / 1.25, true);
    if (e.key.toLowerCase() === 'p') togglePlay();
    if (e.key.toLowerCase() === 'c') document.body.classList.toggle('hide-pins');
    if (e.key === 'Escape') select(null);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const cur = selected ? frames.indexOf(selected.closest('.frame')) : -1;
      const n = (cur + (e.key === 'ArrowRight' ? 1 : frames.length - 1)) % frames.length;
      select(frames[n]); zoomToFrame(frames[n]);
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; vp.classList.remove('space'); } });
  window.addEventListener('resize', () => apply(false));

  /* ---------- minimap ---------- */
  const mctx = mini.getContext('2d');
  mini.width = 400; mini.height = 260;
  function miniScale() {
    const b = worldBounds();
    const k = Math.min(380 / b.w, 240 / b.h);
    return { b, k, ox: (400 - b.w * k) / 2, oy: (260 - b.h * k) / 2 };
  }
  function drawMini() {
    const { b, k, ox, oy } = miniScale();
    mctx.clearRect(0, 0, 400, 260);
    frames.forEach((f) => {
      const r = frameRect(f);
      mctx.fillStyle = f === selected?.closest?.('.frame') ? '#0d99ff88' : '#ffffff22';
      mctx.fillRect(ox + (r.x - b.x) * k, oy + (r.y - b.y) * k, r.w * k, r.h * k);
    });
    mctx.strokeStyle = '#0d99ff'; mctx.lineWidth = 3;
    mctx.strokeRect(ox + (-x / s - b.x) * k, oy + (-y / s - b.y) * k, vp.clientWidth / s * k, vp.clientHeight / s * k);
  }
  mini.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const { b, k, ox, oy } = miniScale();
    const rr = mini.getBoundingClientRect();
    const wx = ((e.clientX - rr.left) * 2 - ox) / k + b.x, wy = ((e.clientY - rr.top) * 2 - oy) / k + b.y;
    x = vp.clientWidth / 2 - wx * s; y = vp.clientHeight / 2 - wy * s;
    apply(true);
  });

  /* ---------- play mode ---------- */
  const playBtn = document.getElementById('playBtn');
  function togglePlay(force) {
    playing = force ?? !playing;
    document.body.classList.toggle('playing', playing);
    playBtn.classList.toggle('on', playing);
    playBtn.textContent = playing ? '■ Stop' : '▶ Play';
    cleanups.forEach((c) => c && c()); cleanups = [];
    if (playing) frames.forEach((f) => { const fn = players[f.dataset.name]; if (fn) cleanups.push(fn(f)); });
  }
  playBtn.addEventListener('click', () => togglePlay());
  document.getElementById('fitBtn').addEventListener('click', fitAll);
  document.getElementById('pinBtn').addEventListener('click', (e) => {
    document.body.classList.toggle('hide-pins');
    e.currentTarget.classList.toggle('on', !document.body.classList.contains('hide-pins'));
  });

  /* ---------- helpers for frames ---------- */
  // loop(fn, ms) inside a player — returns cleanup
  function loop(steps) {
    let alive = true, timer;
    (async function run() {
      while (alive) {
        for (const [fn, ms] of steps) {
          if (!alive) return;
          fn();
          await new Promise((r) => (timer = setTimeout(r, ms)));
        }
      }
    })();
    return () => { alive = false; clearTimeout(timer); };
  }

  // Draw curved wires between elements (by id) inside a container. Returns { send(i) } for packets.
  let wireSeq = 0;
  function wire(container, edges) {
    const svg = document.createElementNS(NS, 'svg');
    svg.classList.add('wires');
    svg.dataset.seq = ++wireSeq;
    svg.setAttribute('width', container.offsetWidth);
    svg.setAttribute('height', container.offsetHeight);
    const defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    container.prepend(svg);
    const out = [];
    edges.forEach((e) => {
      const a = container.querySelector('#' + e.from), b = container.querySelector('#' + e.to);
      if (!a || !b) return;
      const ra = relRect(a, container), rb = relRect(b, container);
      const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
      const horiz = e.dir ? e.dir === 'h' : Math.abs(cb.x - ca.x) > Math.abs(cb.y - ca.y);
      let p1, p2, c1, c2;
      if (horiz) {
        const sgn = cb.x > ca.x ? 1 : -1;
        p1 = { x: ca.x + sgn * ra.w / 2, y: ca.y + (e.oy || 0) }; p2 = { x: cb.x - sgn * rb.w / 2, y: cb.y + (e.oy2 ?? e.oy ?? 0) };
        const k = Math.max(40, Math.abs(p2.x - p1.x) / 2);
        c1 = { x: p1.x + sgn * k, y: p1.y }; c2 = { x: p2.x - sgn * k, y: p2.y };
      } else {
        const sgn = cb.y > ca.y ? 1 : -1;
        p1 = { x: ca.x + (e.ox || 0), y: ca.y + sgn * ra.h / 2 }; p2 = { x: cb.x + (e.ox2 ?? e.ox ?? 0), y: cb.y - sgn * rb.h / 2 };
        const k = Math.max(40, Math.abs(p2.y - p1.y) / 2);
        c1 = { x: p1.x, y: p1.y + sgn * k }; c2 = { x: p2.x, y: p2.y - sgn * k };
      }
      const color = e.color || '#6b7280';
      const mid = 'w' + svg.dataset.seq + '-' + color.replace(/[^a-z0-9]/gi, '');
      if (!svg.querySelector('#arr' + mid)) {
        const m = document.createElementNS(NS, 'marker');
        m.setAttribute('id', 'arr' + mid); m.setAttribute('viewBox', '0 0 10 10'); m.setAttribute('refX', '9'); m.setAttribute('refY', '5');
        m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7'); m.setAttribute('orient', 'auto-start-reverse');
        m.innerHTML = `<path d="M0 0L10 5L0 10z" fill="${color}"/>`;
        defs.appendChild(m);
      }
      const d = `M${p1.x} ${p1.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'w' + (e.dash ? ' dash' : '') + (e.flow !== false ? ' flow' : ''));
      path.setAttribute('stroke', color);
      path.setAttribute('marker-end', `url(#arr${mid})`);
      if (e.both) path.setAttribute('marker-start', `url(#arr${mid})`);
      svg.appendChild(path);
      if (e.label) {
        const t = document.createElementNS(NS, 'text');
        const mx = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
        const my = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
        t.setAttribute('x', mx + (e.lx || 0)); t.setAttribute('y', my - 6 + (e.ly || 0));
        t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', color);
        t.textContent = e.label;
        svg.appendChild(t);
      }
      out.push({ d, color, path, a, b });
    });
    return {
      edges: out,
      send(i, dur = 0.9, color) {
        const e = out[i]; if (!e) return;
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', 7); c.setAttribute('fill', color || e.color);
        c.setAttribute('style', `filter:drop-shadow(0 0 6px ${color || e.color})`);
        const am = document.createElementNS(NS, 'animateMotion');
        am.setAttribute('dur', dur + 's'); am.setAttribute('path', e.d); am.setAttribute('fill', 'freeze'); am.setAttribute('begin', 'indefinite');
        c.appendChild(am); svg.appendChild(c);
        try { am.beginElement(); } catch (_) {}
        setTimeout(() => c.remove(), dur * 1000 + 50);
      }
    };
  }

  renderInspector(null);
  requestAnimationFrame(() => { fitAll(); setTimeout(() => togglePlay(true), 700); });

  return { on: (name, fn) => (players[name] = fn), loop, wire, select, fitAll, zoomToFrame, relRect };
})();
