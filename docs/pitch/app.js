const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- tiny TypeScript highlighter ---------- */
const TOKEN = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*')|\b(import|from|export|const|let|async|await|function|return|if|for|of|new|type|as|while|true|false|Promise|void|string|boolean|number)\b|\b([A-Za-z_]\w*)(?=\()/g;
function highlight(code) {
  return esc(code).replace(TOKEN, (m, com, str, kw, fn) =>
    com ? `<span class="c">${com}</span>` :
    str ? `<span class="s">${str}</span>` :
    kw  ? `<span class="k">${kw}</span>` :
          `<span class="f">${fn}</span>`);
}

/* ---------- hero: watch it heal ---------- */
let healing = false;
async function heal() {
  if (healing) return;
  healing = true;
  const btn = $('#heal'), page = $('#page'), cur = $('#cursor'), ring = $('#ring');
  const checkout = $('#checkout'), toast = $('#toast'), live = $('#liveTag'), bug = $('#bugbtn');
  const nodes = [...document.querySelectorAll('#pipe .node')];
  btn.disabled = true;
  nodes.forEach((n) => n.classList.remove('on'));
  checkout.classList.remove('broken');
  toast.className = 'toast';

  // Anchor agent moves to checkout and clicks it
  const x = checkout.offsetLeft + checkout.offsetWidth / 2, y = checkout.offsetTop + checkout.offsetHeight / 2;
  cur.style.left = x + 'px'; cur.style.top = y + 'px';
  await sleep(950);
  ring.style.left = x + 'px'; ring.style.top = y + 'px';
  ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
  await sleep(250);

  checkout.classList.add('broken');
  checkout.textContent = 'Error 500';
  live.textContent = '● incident'; live.classList.add('down');
  bug.classList.add('flag');
  showToast('err', '✖ TypeError: cart.total is undefined (checkout.ts:42)');
  await sleep(1200);

  const msgs = [
    'Anchor: flow "checkout" failed at step 3/5',
    'SurrealDB: 2 similar past bugs recalled',
    'Daytona: reproduced in sandbox (11.4s)',
    'Bedrock: patch guards optional cart',
    'AWS: canary 5% → 100% healthy',
    'Arize: fix quality 93/100'
  ];
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].classList.add('on');
    showToast('err', '⟳ ' + msgs[i]);
    await sleep(850);
  }

  checkout.classList.remove('broken');
  checkout.textContent = 'Checkout · $49';
  bug.classList.remove('flag');
  live.textContent = '● healed v1.4.3'; live.classList.remove('down');
  showToast('okk', '✔ Fixed and deployed in 38s, no human needed');
  cur.style.left = '78%'; cur.style.top = '18%';
  btn.disabled = false; btn.textContent = '↻ Break it again';
  healing = false;

  function showToast(kind, text) {
    toast.className = 'toast ' + kind + ' show';
    toast.textContent = text;
  }
}
$('#heal').addEventListener('click', heal);
setTimeout(heal, 900); // auto-play once on load

/* ---------- idea cards ---------- */
const grid = $('#grid');
IDEAS.forEach((idea, i) => {
  const card = document.createElement('button');
  card.className = 'card';
  card.style.setProperty('--c', idea.c);
  card.innerHTML = `
    ${idea.badge ? `<span class="badge">${idea.badge}</span>` : ''}
    <div class="num">IDEA 0${i + 1}</div>
    <h3>${idea.title}</h3>
    <p>${esc(idea.short)}</p>
    <div class="chips">${Object.keys(SPONSORS).map((k) =>
      `<span class="chip" style="--c:${SPONSORS[k].c}">${SPONSORS[k].short}</span>`).join('')}</div>
    <div class="open">Run the agent</div>`;
  card.addEventListener('click', (e) => {
    const r = card.getBoundingClientRect();
    const rip = document.createElement('span');
    rip.className = 'ripple';
    rip.style.left = (e.clientX - r.left) + 'px';
    rip.style.top = (e.clientY - r.top) + 'px';
    card.appendChild(rip);
    setTimeout(() => rip.remove(), 600);
    setTimeout(() => openIdea(i), 180);
  });
  grid.appendChild(card);
});

const io = new IntersectionObserver((entries) => entries.forEach((en) => {
  if (!en.isIntersecting) return;
  const idx = [...grid.children].indexOf(en.target);
  setTimeout(() => en.target.classList.add('in'), idx * 90);
  io.unobserve(en.target);
}), { threshold: 0.15 });
[...grid.children].forEach((c) => io.observe(c));

/* ---------- sponsor matrix ---------- */
const mx = $('#mx');
mx.innerHTML = `<thead><tr><th>Idea</th>${Object.values(SPONSORS).map((s) =>
  `<th><span class="dot" style="--c:${s.c}"></span>${s.short}</th>`).join('')}</tr></thead>
  <tbody>${IDEAS.map((idea, i) => `<tr><td data-i="${i}">0${i + 1} · ${idea.title}</td>${
    Object.keys(SPONSORS).map((k) => `<td>${esc(idea.roles[k])}</td>`).join('')}</tr>`).join('')}</tbody>`;
mx.addEventListener('click', (e) => {
  const td = e.target.closest('td[data-i]');
  if (td) openIdea(+td.dataset.i);
});

/* ---------- modal ---------- */
const modal = $('#modal');
let runToken = 0, current = null;

function openIdea(i) {
  const idea = IDEAS[i];
  current = idea;
  runToken++;
  $('.sheet').style.setProperty('--c', idea.c);
  $('#mNum').textContent = 'IDEA 0' + (i + 1);
  $('#mNum').style.color = idea.c;
  $('#mTitle').textContent = idea.title;
  $('#mDesc').textContent = idea.desc;
  $('#mChips').innerHTML = Object.values(SPONSORS).map((s) =>
    `<a class="chip" style="--c:${s.c};text-decoration:none" href="${s.url}" target="_blank" rel="noopener">${s.name} ↗</a>`).join('');

  $('#steps').innerHTML = idea.steps.map(([sp, label, sub], n) =>
    `<li class="step" style="--c:${SPONSORS[sp].c}"><span class="ic">${n + 1}</span>
      <div><b>${label}</b><span>${sub}</span></div><span class="who">${SPONSORS[sp].short}</span></li>`).join('');
  $('#term').innerHTML = '<div class="l t">$ healops run --idea "' + esc(idea.title) + '"</div><span class="caret"></span>';
  $('#status').textContent = 'idle';
  $('#meter').style.width = '0';
  $('#scoreTxt').textContent = '--';
  $('#why').innerHTML = idea.why.map(([b, t]) => `<div><b>${b}</b>${t}</div>`).join('');

  const files = Object.keys(idea.code);
  $('#tabs').innerHTML = files.map((f, n) => `<button class="tab${n ? '' : ' on'}" data-f="${f}">${f}</button>`).join('');
  $('#code').innerHTML = highlight(idea.code[files[0]]);

  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  setTimeout(runIdea, 500); // auto-run on open
}

function closeModal() {
  runToken++;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function runIdea() {
  const token = ++runToken, idea = current;
  const term = $('#term'), steps = [...document.querySelectorAll('#steps .step')], run = $('#run');
  run.disabled = true;
  steps.forEach((s) => s.classList.remove('active', 'done'));
  term.innerHTML = '<div class="l t">$ healops run --idea "' + esc(idea.title) + '"</div><span class="caret"></span>';
  $('#meter').style.width = '0';
  $('#scoreTxt').textContent = '--';
  $('#status').textContent = 'running…';
  $('#status').style.color = 'var(--warn)';

  for (let n = 0; n < idea.steps.length; n++) {
    if (token !== runToken) return;
    const [sp, label, , lines] = idea.steps[n];
    steps[n].classList.add('active');
    steps[n].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    log(`[${SPONSORS[sp].short}] ${label}`, 't');
    for (const line of lines) {
      await sleep(420);
      if (token !== runToken) return;
      const kind = { '+': 'ok', '!': 'bad', '~': 'warn' }[line[0]];
      log(kind ? line.slice(2) : line, kind);
    }
    await sleep(380);
    steps[n].classList.replace('active', 'done');
  }
  if (token !== runToken) return;
  $('#meter').style.width = idea.score + '%';
  countUp($('#scoreTxt'), idea.score, token);
  $('#status').textContent = 'healed ✓';
  $('#status').style.color = 'var(--ok)';
  log('✔ loop complete, all sponsors exercised', 'ok');
  run.disabled = false;
  run.textContent = '↻ Replay';

  function log(text, kind) {
    const div = document.createElement('div');
    div.className = 'l';
    div.innerHTML = kind ? `<${kind}>${esc(text)}</${kind}>` : esc(text);
    if (kind === 't') div.className = 'l t';
    term.insertBefore(div, term.lastElementChild);
    term.scrollTop = term.scrollHeight;
  }
}

async function countUp(el, to, token) {
  for (let v = 0; v <= to; v += 3) {
    if (token !== runToken) return;
    el.textContent = v + '/100';
    await sleep(25);
  }
  el.textContent = to + '/100';
}

$('#run').addEventListener('click', runIdea);
$('#close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t || !current) return;
  document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('on', b === t));
  $('#code').innerHTML = highlight(current.code[t.dataset.f]);
});
