'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    grid: $('#grid'), scroller: $('#scroller'), empty: $('#empty'), summary: $('#summary'), toast: $('#toast'),
    topbar: $('#topbar'), selbar: $('#selbar'), selCount: $('#selCount'),
    btnImport: $('#btnImport'), btnImport2: $('#btnImport2'), btnSelect: $('#btnSelect'),
    btnSelClose: $('#btnSelClose'), btnSelAll: $('#btnSelAll'), btnInstall: $('#btnInstall'),
    selActions: $('#selActions'), actSave: $('#actSave'), actShare: $('#actShare'), actDelete: $('#actDelete'),
    picker: $('#picker'),
    viewer: $('#viewer'), viewTrack: $('#viewTrack'), viewStage: $('#viewStage'), viewClose: $('#viewClose'),
    viewCount: $('#viewCount'), viewName: $('#viewName'),
    vSave: $('#vSave'), vShare: $('#vShare'), vDelete: $('#vDelete')
  };

  /* =========================================================
     Utilidades
     ========================================================= */
  let toastTimer;
  function toast(text, ms = 2400) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }
  const vibrate = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* nada */ } };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function fmtSize(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }
  const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  function dayLabel(ts) {
    if (!ts) return 'Sin fecha';
    const now = new Date(), d = new Date(ts);
    if (dayKey(ts) === dayKey(now.getTime())) return 'Hoy';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(ts) === dayKey(y.getTime())) return 'Ayer';
    const s = d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function download(item) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(item.blob);
    a.download = item.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 6000);
  }
  function downloadMany(items) {
    items.forEach((it, i) => setTimeout(() => download(it), i * 450));
  }

  async function shareItems(items) {
    try {
      const files = items.map(it => new File([it.blob], it.name, { type: it.mime || (it.type === 'photo' ? 'image/jpeg' : 'video/mp4') }));
      if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files });
      else { downloadMany(items); toast('Compartir no está disponible: se descargaron los archivos', 3200); }
    } catch (e) {
      if (e.name !== 'AbortError') toast('No se pudo compartir');
    }
  }

  /* Botón de dos toques para eliminar */
  function confirmTwice(btn, idle, armed) {
    const label = btn.querySelector('span');
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm'); label.textContent = armed;
      clearTimeout(btn._t);
      btn._t = setTimeout(() => resetConfirm(btn, idle), 3000);
      return false;
    }
    resetConfirm(btn, idle);
    return true;
  }
  function resetConfirm(btn, idle) {
    clearTimeout(btn._t);
    btn.classList.remove('confirm');
    btn.querySelector('span').textContent = idle;
  }

  /* =========================================================
     Datos
     La cámara guarda en 'camara-db' (almacén 'media'); como ambas apps
     viven en el mismo sitio, la galería lee esa misma base de datos.
     Si aún no existe, se crea con EXACTAMENTE el mismo esquema que usa la cámara.
     Lo importado desde el teléfono se guarda aparte, en 'galeria-db'.
     ========================================================= */
  const CAM_DB = 'camara-db', CAM_STORE = 'media';
  const OWN_DB = 'galeria-db', OWN_STORE = 'imports';
  const dbs = {};

  function getDb(name, store) {
    if (!dbs[name]) {
      dbs[name] = new Promise((res, rej) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store, { keyPath: 'id', autoIncrement: true });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('Base de datos bloqueada'));
      }).catch(e => { delete dbs[name]; throw e; });
    }
    return dbs[name];
  }
  async function readAll(name, store) {
    const d = await getDb(name, store);
    return new Promise((res, rej) => {
      const rq = d.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function writeOp(name, store, fn) {
    const d = await getDb(name, store);
    return new Promise((res, rej) => {
      const t = d.transaction(store, 'readwrite');
      const rq = fn(t.objectStore(store));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  const norm = (r, src) => ({
    key: src + ':' + r.id, src, id: r.id,
    type: r.type === 'video' ? 'video' : 'photo',
    blob: r.blob, mime: r.mime || (r.blob && r.blob.type) || '',
    name: r.name || ('archivo_' + r.id), created: r.created || 0,
    size: r.size || (r.blob && r.blob.size) || 0
  });

  let all = [], list = [], filter = 'all';
  const urls = new Map();
  function urlFor(it) {
    let u = urls.get(it.key);
    if (!u) { u = URL.createObjectURL(it.blob); urls.set(it.key, u); }
    return u;
  }
  function dropUrl(key) {
    const u = urls.get(key);
    if (u) { URL.revokeObjectURL(u); urls.delete(key); }
  }

  async function load() {
    let cam = [], imp = [];
    try { cam = await readAll(CAM_DB, CAM_STORE); } catch { /* sin datos de la cámara */ }
    try { imp = await readAll(OWN_DB, OWN_STORE); } catch { /* sin importados */ }
    const next = [...cam.filter(r => r && r.blob).map(r => norm(r, 'cam')), ...imp.filter(r => r && r.blob).map(r => norm(r, 'imp'))]
      .sort((a, b) => b.created - a.created);
    const keep = new Set(next.map(i => i.key));
    [...urls.keys()].forEach(k => { if (!keep.has(k)) dropUrl(k); });
    all = next;
  }
  const signature = () => all.map(i => i.key).join('|');

  /* =========================================================
     Cuadrícula
     ========================================================= */
  const selected = new Set();
  let selecting = false;
  let tileEls = [];

  const loadTile = t => {
    const it = list[+t.dataset.i];
    if (!it || t.dataset.loaded) return;
    t.dataset.loaded = '1';
    const isPhoto = it.type === 'photo';
    const m = document.createElement(isPhoto ? 'img' : 'video');
    if (isPhoto) { m.alt = ''; m.decoding = 'async'; m.addEventListener('load', () => m.classList.add('ready')); m.src = urlFor(it); }
    else { m.muted = true; m.playsInline = true; m.preload = 'metadata'; m.addEventListener('loadeddata', () => m.classList.add('ready')); m.src = urlFor(it) + '#t=0.1'; }
    setTimeout(() => m.classList.add('ready'), 600);
    t.prepend(m);
  };
  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { observer.unobserve(e.target); loadTile(e.target); } });
      }, { root: el.scroller, rootMargin: '500px' })
    : null;

  function makeTile(it, i) {
    const b = document.createElement('button');
    b.className = 'tile' + (selected.has(it.key) ? ' sel' : '');
    b.dataset.i = i; b.dataset.key = it.key;
    b.setAttribute('aria-label', (it.type === 'photo' ? 'Foto ' : 'Video ') + (it.created ? new Date(it.created).toLocaleString('es') : it.name));
    const chk = document.createElement('span'); chk.className = 'chk';
    chk.innerHTML = '<svg class="ic"><use href="#i-check"/></svg>';
    b.append(chk);
    if (it.type === 'video') {
      const badge = document.createElement('span'); badge.className = 'badge';
      badge.innerHTML = '<svg class="ic"><use href="#i-play"/></svg>';
      b.append(badge);
    }
    return b;
  }

  function applyFilter() {
    list = filter === 'all' ? all.slice() : all.filter(i => i.type === filter);
  }

  function renderGrid() {
    if (observer) observer.disconnect();
    applyFilter();
    const frag = document.createDocumentFragment();
    let last = '';
    list.forEach((it, i) => {
      const k = it.created ? dayKey(it.created) : 'none';
      if (k !== last) {
        last = k;
        const h = document.createElement('h2'); h.className = 'day'; h.textContent = dayLabel(it.created);
        frag.append(h);
      }
      frag.append(makeTile(it, i));
    });
    el.grid.replaceChildren(frag);
    tileEls = [];
    $$('.tile', el.grid).forEach(t => { tileEls[+t.dataset.i] = t; if (observer) observer.observe(t); else loadTile(t); });
    el.empty.hidden = all.length > 0;
    el.grid.hidden = list.length === 0;
    const total = all.reduce((s, i) => s + i.size, 0);
    el.summary.textContent = all.length ? `${plural(all.length, 'elemento', 'elementos')} · ${fmtSize(total)}` : '';
    el.btnSelect.hidden = all.length === 0;
  }

  async function refresh(force) {
    const before = signature();
    await load();
    if (force || signature() !== before) renderGrid();
  }

  /* Filtros */
  $$('.chips button').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    $$('.chips button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderGrid();
    el.scroller.scrollTop = 0;
  }));

  /* =========================================================
     Selección
     ========================================================= */
  function selItems() { return all.filter(i => selected.has(i.key)); }

  function updateSelectionUI() {
    const n = selected.size;
    el.selCount.textContent = n === 1 ? '1 seleccionado' : `${n} seleccionados`;
    [el.actSave, el.actShare, el.actDelete].forEach(b => { b.disabled = n === 0; });
    resetConfirm(el.actDelete, 'Eliminar');
    el.btnSelAll.textContent = n && n === list.length ? 'Ninguno' : 'Todo';
  }
  function setSelecting(on) {
    selecting = on;
    document.body.classList.toggle('selecting', on);
    el.topbar.hidden = on; el.selbar.hidden = !on; el.selActions.hidden = !on;
    if (!on) { selected.clear(); $$('.tile.sel', el.grid).forEach(t => t.classList.remove('sel')); }
    updateSelectionUI();
  }
  function toggleItem(it) {
    const t = el.grid.querySelector(`.tile[data-key="${CSS.escape(it.key)}"]`);
    if (selected.has(it.key)) { selected.delete(it.key); if (t) t.classList.remove('sel'); }
    else { selected.add(it.key); if (t) t.classList.add('sel'); }
    if (selected.size === 0) setSelecting(false); else updateSelectionUI();
  }

  el.btnSelect.addEventListener('click', () => setSelecting(true));
  el.btnSelClose.addEventListener('click', () => setSelecting(false));
  el.btnSelAll.addEventListener('click', () => {
    if (selected.size === list.length) { setSelecting(false); return; }
    list.forEach(i => selected.add(i.key));
    $$('.tile', el.grid).forEach(t => t.classList.add('sel'));
    updateSelectionUI();
  });

  /* Tocar y mantener para empezar a seleccionar; sin soltar, arrastra para seleccionar varias */
  let press = null, suppressClick = false, dragSel = null, lastPt = null, scrollRaf = 0;

  const tileIndexAt = (x, y) => {
    const n = document.elementFromPoint(x, y);
    const t = n && n.closest ? n.closest('.tile') : null;
    return t ? +t.dataset.i : -1;
  };

  // Marca (o desmarca) todo el rango entre el primer elemento y el que está bajo el dedo
  function paintRange(c) {
    const d = dragSel;
    if (!d || c < 0) return;
    const lo = Math.min(d.anchor, c), hi = Math.max(d.anchor, c);
    if (lo === d.lo && hi === d.hi) return;
    const next = new Set(d.base);
    for (let i = lo; i <= hi; i++) {
      const k = list[i] && list[i].key;
      if (!k) continue;
      if (d.mode === 'select') next.add(k); else next.delete(k);
    }
    const from = Math.min(lo, d.lo), to = Math.max(hi, d.hi);
    selected.clear(); next.forEach(k => selected.add(k));
    for (let i = from; i <= to; i++) {
      const t = tileEls[i];
      if (t && list[i]) t.classList.toggle('sel', selected.has(list[i].key));
    }
    d.lo = lo; d.hi = hi;
    updateSelectionUI();
  }

  // Desplazamiento automático al acercar el dedo al borde de arriba o abajo
  const edgeDir = y => {
    const r = el.scroller.getBoundingClientRect();
    return y < r.top + 90 ? -1 : (y > r.bottom - 130 ? 1 : 0);
  };
  function edgeScroll() {
    if (scrollRaf || !dragSel || !lastPt || !edgeDir(lastPt.y)) return;
    const step = () => {
      scrollRaf = 0;
      if (!dragSel || !lastPt) return;
      const dir = edgeDir(lastPt.y);
      if (!dir) return;
      el.scroller.scrollTop += dir * 14;
      paintRange(tileIndexAt(lastPt.x, lastPt.y));
      scrollRaf = requestAnimationFrame(step);
    };
    scrollRaf = requestAnimationFrame(step);
  }

  el.grid.addEventListener('pointerdown', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    press = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        const i = +t.dataset.i, it = list[i];
        if (!it) return;
        suppressClick = true; vibrate(18);
        if (!selecting) setSelecting(true);
        dragSel = { anchor: i, mode: selected.has(it.key) ? 'deselect' : 'select', base: new Set(selected), lo: i, hi: i - 1 };
        lastPt = { x: e.clientX, y: e.clientY };
        paintRange(i);
      }, 450)
    };
  });
  el.grid.addEventListener('pointermove', e => {
    if (press) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
      return;
    }
    if (dragSel) {
      lastPt = { x: e.clientX, y: e.clientY };
      paintRange(tileIndexAt(e.clientX, e.clientY));
      edgeScroll();
    }
  });
  // Mientras se arrastra para seleccionar, la pantalla no debe desplazarse sola
  el.grid.addEventListener('touchmove', e => { if (dragSel && e.cancelable) e.preventDefault(); }, { passive: false });

  const endPress = () => {
    if (press) { clearTimeout(press.timer); press = null; }
    if (dragSel) {
      dragSel = null; lastPt = null;
      cancelAnimationFrame(scrollRaf); scrollRaf = 0;
      if (selected.size === 0) setSelecting(false);
    }
    // El "clic" que a veces llega al soltar se ignora; el seguro se quita siempre, llegue o no ese clic
    if (suppressClick) setTimeout(() => { suppressClick = false; }, 80);
  };
  el.grid.addEventListener('pointerup', endPress);
  el.grid.addEventListener('pointercancel', endPress);
  el.grid.addEventListener('contextmenu', e => e.preventDefault());
  el.grid.addEventListener('click', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    if (suppressClick) return;
    const it = list[+t.dataset.i]; if (!it) return;
    if (selecting) toggleItem(it); else openViewer(+t.dataset.i);
  });

  /* Acciones sobre la selección */
  el.actSave.addEventListener('click', () => {
    const items = selItems(); if (!items.length) return;
    downloadMany(items);
    toast(items.length === 1 ? 'Guardando en el teléfono…' : `Guardando ${items.length} archivos…`);
  });
  el.actShare.addEventListener('click', () => { const items = selItems(); if (items.length) shareItems(items); });
  el.actDelete.addEventListener('click', async () => {
    const items = selItems(); if (!items.length) return;
    if (!confirmTwice(el.actDelete, 'Eliminar', `Toca otra vez para eliminar ${items.length}`)) return;
    const n = await removeItems(items);
    setSelecting(false);
    renderGrid();
    toast(n === 1 ? 'Eliminado' : `${n} eliminados`);
  });

  async function removeItems(items) {
    const gone = new Set();
    for (const it of items) {
      try {
        if (it.src === 'cam') await writeOp(CAM_DB, CAM_STORE, s => s.delete(it.id));
        else await writeOp(OWN_DB, OWN_STORE, s => s.delete(it.id));
        gone.add(it.key);
      } catch { /* se omite */ }
    }
    all = all.filter(i => !gone.has(i.key));
    gone.forEach(dropUrl);
    if (gone.size < items.length) toast('Algunos elementos no se pudieron eliminar');
    return gone.size;
  }

  /* =========================================================
     Importar desde el teléfono
     ========================================================= */
  const openPicker = () => el.picker.click();
  el.btnImport.addEventListener('click', openPicker);
  el.btnImport2.addEventListener('click', openPicker);
  el.picker.addEventListener('change', async () => {
    const files = [...el.picker.files].filter(f => /^(image|video)\//.test(f.type));
    el.picker.value = '';
    if (!files.length) return;
    toast(`Importando ${plural(files.length, 'archivo', 'archivos')}…`, 4000);
    let ok = 0;
    for (const f of files) {
      try {
        await writeOp(OWN_DB, OWN_STORE, s => s.add({
          type: f.type.startsWith('video') ? 'video' : 'photo',
          blob: f, mime: f.type, name: f.name, size: f.size, created: f.lastModified || Date.now()
        }));
        ok++;
      } catch { /* sin espacio u otro error */ }
    }
    await refresh(true);
    toast(ok === files.length ? `${plural(ok, 'archivo importado', 'archivos importados')}` : `Se importaron ${ok} de ${files.length}: revisa el espacio del teléfono`, 3600);
  });

  /* =========================================================
     Visor con deslizamiento
     ========================================================= */
  const vtrack = el.viewTrack;
  let viewIndex = -1, animating = false, drag = null;

  function makeSlide(i, current) {
    const slide = document.createElement('div'); slide.className = 'slide';
    const it = list[i];
    if (!it) return slide;
    let m;
    if (it.type === 'photo') {
      m = document.createElement('img'); m.alt = it.name; m.decoding = 'async'; m.draggable = false;
      m.addEventListener('load', () => m.classList.add('ready'));
      m.src = urlFor(it);
    } else {
      m = document.createElement('video'); m.playsInline = true; m.preload = 'metadata'; m.controls = !!current;
      m.addEventListener('loadeddata', () => m.classList.add('ready'));
      m.src = urlFor(it) + '#t=0.1';
    }
    setTimeout(() => m.classList.add('ready'), 450);
    slide.append(m);
    return slide;
  }
  function renderSlides() {
    vtrack.style.transition = 'none';
    vtrack.style.transform = 'translate3d(-100%, 0, 0)';
    vtrack.replaceChildren(makeSlide(viewIndex - 1, false), makeSlide(viewIndex, true), makeSlide(viewIndex + 1, false));
  }
  function updateViewerUI() {
    const it = list[viewIndex]; if (!it) return;
    el.viewCount.textContent = `${viewIndex + 1} de ${list.length}`;
    el.viewName.textContent = `${it.name} · ${fmtSize(it.size)}`;
    resetConfirm(el.vDelete, 'Eliminar');
  }
  function openViewer(i) {
    viewIndex = i;
    if (!el.viewer.open) el.viewer.showModal();
    renderSlides(); updateViewerUI();
  }
  function snapBack() {
    animating = true;
    vtrack.style.transition = 'transform .22s ease-out';
    vtrack.style.transform = 'translate3d(-100%, 0, 0)';
    setTimeout(() => { animating = false; }, 230);
  }
  function slideTo(dir) {
    const n = viewIndex + dir;
    if (animating) return;
    if (n < 0 || n >= list.length) { snapBack(); return; }
    animating = true;
    vtrack.querySelectorAll('video').forEach(v => v.pause());
    vtrack.style.transition = 'transform .28s cubic-bezier(.22, .8, .3, 1)';
    vtrack.style.transform = `translate3d(${dir > 0 ? -200 : 0}%, 0, 0)`;
    let finished = false;
    const onEnd = e => { if (e.target === vtrack) finish(); };
    const finish = () => {
      if (finished) return; finished = true;
      vtrack.removeEventListener('transitionend', onEnd);
      viewIndex = n; animating = false;
      renderSlides(); updateViewerUI();
    };
    vtrack.addEventListener('transitionend', onEnd);
    setTimeout(finish, 380);
  }

  el.viewClose.addEventListener('click', () => el.viewer.close());
  el.viewer.addEventListener('close', () => { vtrack.replaceChildren(); resetConfirm(el.vDelete, 'Eliminar'); });
  document.addEventListener('keydown', e => {
    if (!el.viewer.open) return;
    if (e.key === 'ArrowLeft') slideTo(-1);
    if (e.key === 'ArrowRight') slideTo(1);
  });

  el.viewStage.addEventListener('pointerdown', e => {
    if (animating || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const v = e.target.closest && e.target.closest('video');
    if (v) { const r = v.getBoundingClientRect(); if (e.clientY > r.bottom - 72) return; }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, t: Date.now(), moving: false };
  });
  el.viewStage.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moving) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      drag.moving = true;
      try { el.viewStage.setPointerCapture(e.pointerId); } catch { /* nada */ }
      vtrack.style.transition = 'none';
    }
    const edge = (viewIndex === 0 && dx > 0) || (viewIndex === list.length - 1 && dx < 0);
    drag.dx = edge ? dx / 3 : dx;
    vtrack.style.transform = `translate3d(calc(-100% + ${drag.dx}px), 0, 0)`;
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moving) return;
    const w = el.viewStage.clientWidth || 1;
    const v = d.dx / Math.max(1, Date.now() - d.t);
    const fast = Math.abs(v) > 0.4 && Math.abs(d.dx) > 30;
    if (d.dx < 0 && (d.dx < -w * 0.22 || fast)) slideTo(1);
    else if (d.dx > 0 && (d.dx > w * 0.22 || fast)) slideTo(-1);
    else snapBack();
  };
  el.viewStage.addEventListener('pointerup', endDrag);
  el.viewStage.addEventListener('pointercancel', endDrag);

  /* Acciones del visor */
  el.vSave.addEventListener('click', () => { const it = list[viewIndex]; if (it) { download(it); toast('Guardando en el teléfono…'); } });
  el.vShare.addEventListener('click', () => { const it = list[viewIndex]; if (it) shareItems([it]); });
  el.vDelete.addEventListener('click', async () => {
    const it = list[viewIndex]; if (!it) return;
    if (!confirmTwice(el.vDelete, 'Eliminar', 'Toca otra vez para eliminar')) return;
    const n = await removeItems([it]);
    if (!n) return;
    renderGrid();
    if (!list.length) { el.viewer.close(); toast('Eliminado'); return; }
    viewIndex = Math.min(viewIndex, list.length - 1);
    renderSlides(); updateViewerUI();
    toast('Eliminado');
  });

  /* =========================================================
     Instalación y actualizaciones
     ========================================================= */
  let deferredPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (!isStandalone()) el.btnInstall.hidden = false; });
  addEventListener('appinstalled', () => { deferredPrompt = null; el.btnInstall.hidden = true; toast('Galería instalada'); });
  el.btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null; el.btnInstall.hidden = true;
  });

  let swReg = null;
  if ('serviceWorker' in navigator) {
    const ctl = navigator.serviceWorker.controller;
    const hadOwnController = !!(ctl && ctl.scriptURL === new URL('./sw.js', location.href).href);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadOwnController || reloading) return;
      reloading = true; location.reload();
    });
    addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then(reg => { swReg = reg; reg.update().catch(() => {}); })
        .catch(() => {});
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (swReg) swReg.update().catch(() => {});
    if (!el.viewer.open && !selecting) refresh(false);
  });

  /* Persistencia: evita que el navegador borre lo guardado cuando falta espacio */
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* =========================================================
     Inicio
     ========================================================= */
  window.__appReady = true;
  try { sessionStorage.removeItem('galHeal'); } catch { /* nada */ }
  setSelecting(false);
  refresh(true);
})();
