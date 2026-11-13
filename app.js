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
    vEdit: $('#vEdit'), vSave: $('#vSave'), vShare: $('#vShare'), vDelete: $('#vDelete')
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
    el.vEdit.hidden = it.type !== 'photo';
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
    if (!el.viewer.open || (E && E.dlg.open)) return;
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
    if (!confirmTwice(el.vDelete, 'Eliminar', '¿Seguro?')) return;
    const n = await removeItems([it]);
    if (!n) return;
    renderGrid();
    if (!list.length) { el.viewer.close(); toast('Eliminado'); return; }
    viewIndex = Math.min(viewIndex, list.length - 1);
    renderSlides(); updateViewerUI();
    toast('Eliminado');
  });

  /* =========================================================
     Editor de fotos: recortar, girar, voltear, ajustes y filtros
     ========================================================= */
  // <pure>
  const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

  // Rectángulo (en coordenadas 0..1) al arrastrar una esquina. (ax, ay) es la esquina opuesta, fija.
  // nr = proporción ancho/alto en coordenadas normalizadas (0 = libre).
  function cornerRect(ax, ay, px, py, nr) {
    const MIN = 0.06;
    const sx = px >= ax ? 1 : -1, sy = py >= ay ? 1 : -1;
    let w = Math.abs(px - ax), h = Math.abs(py - ay);
    const maxW = sx > 0 ? 1 - ax : ax, maxH = sy > 0 ? 1 - ay : ay;
    if (nr) {
      if (w / Math.max(h, 1e-6) > nr) w = h * nr; else h = w / nr;
      if (w < MIN) { w = MIN; h = w / nr; }
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k; h *= k;
    } else {
      w = Math.min(Math.max(w, MIN), maxW);
      h = Math.min(Math.max(h, MIN), maxH);
    }
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  }

  // Rectángulo centrado con la proporción dada (coordenadas 0..1)
  function centeredRect(nr) {
    let w, h;
    if (nr >= 1) { w = 1; h = 1 / nr; } else { h = 1; w = nr; }
    w *= 0.92; h *= 0.92;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  const FILTERS = [
    { id: 'none', name: 'Normal', f: {} },
    { id: 'bw', name: 'B/N', f: { grayscale: 1, contrast: 1.1 } },
    { id: 'sepia', name: 'Sepia', f: { sepia: 0.85, contrast: 1.05 } },
    { id: 'vivid', name: 'Vívido', f: { saturate: 1.45, contrast: 1.12 } },
    { id: 'cold', name: 'Frío', f: { saturate: 1.05, brightness: 1.02 }, tint: 'rgba(60,120,255,.14)' },
    { id: 'warm', name: 'Cálido', f: { saturate: 1.15, sepia: 0.18 }, tint: 'rgba(255,150,40,.12)' },
    { id: 'fade', name: 'Desvanecido', f: { contrast: 0.82, brightness: 1.08, saturate: 0.85 } }
  ];

  function filterParams(st) {
    const p = FILTERS.find(x => x.id === st.filter) || FILTERS[0], F = p.f, a = st.adj;
    return {
      brightness: (1 + a.b / 100) * (F.brightness || 1),
      contrast: (1 + a.c / 100) * (F.contrast || 1),
      saturate: (1 + a.s / 100) * (F.saturate || 1),
      grayscale: F.grayscale || 0, sepia: F.sepia || 0, tint: p.tint || null
    };
  }
  function cssFilter(f) {
    const parts = [];
    if (f.brightness !== 1) parts.push(`brightness(${f.brightness.toFixed(3)})`);
    if (f.contrast !== 1) parts.push(`contrast(${f.contrast.toFixed(3)})`);
    if (f.saturate !== 1) parts.push(`saturate(${f.saturate.toFixed(3)})`);
    if (f.grayscale) parts.push(`grayscale(${f.grayscale})`);
    if (f.sepia) parts.push(`sepia(${f.sepia})`);
    return parts.join(' ') || 'none';
  }
  // Respaldo para navegadores sin ctx.filter
  function pixelFilter(ctx, w, h, f) {
    const id = ctx.getImageData(0, 0, w, h), d = id.data;
    const b = f.brightness, c = f.contrast, s = f.saturate, g = f.grayscale, sp = f.sepia;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] * b, gg = d[i + 1] * b, bl = d[i + 2] * b;
      r = (r - 128) * c + 128; gg = (gg - 128) * c + 128; bl = (bl - 128) * c + 128;
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * bl;
      r = l + (r - l) * s; gg = l + (gg - l) * s; bl = l + (bl - l) * s;
      if (g) { const l2 = 0.2126 * r + 0.7152 * gg + 0.0722 * bl; r += (l2 - r) * g; gg += (l2 - gg) * g; bl += (l2 - bl) * g; }
      if (sp) {
        const nr = 0.393 * r + 0.769 * gg + 0.189 * bl, ng = 0.349 * r + 0.686 * gg + 0.168 * bl, nb = 0.272 * r + 0.534 * gg + 0.131 * bl;
        r += (nr - r) * sp; gg += (ng - gg) * sp; bl += (nb - bl) * sp;
      }
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg; d[i + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
    }
    ctx.putImageData(id, 0, 0);
  }
  // </pure>

  const hasCtxFilter = (() => { try { const c = document.createElement('canvas').getContext('2d'); return !!c && 'filter' in c; } catch { return false; } })();

  // Dibuja la foto girada/volteada, recortada a `region` (0..1), con ajustes y filtro, a escala `scale`
  function renderTo(canvas, img, W, H, st, region, scale) {
    const ow = st.rot % 2 ? H : W, oh = st.rot % 2 ? W : H;
    const cw = Math.max(1, Math.round(ow * region.w * scale)), ch = Math.max(1, Math.round(oh * region.h * scale));
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    const f = filterParams(st);
    ctx.imageSmoothingQuality = 'high';
    if (hasCtxFilter) ctx.filter = cssFilter(f);
    ctx.save();
    ctx.translate(-region.x * ow * scale, -region.y * oh * scale);
    ctx.scale(scale, scale);
    ctx.translate(ow / 2, oh / 2);
    if (st.flip) ctx.scale(-1, 1);
    ctx.rotate(st.rot * Math.PI / 2);
    ctx.drawImage(img, -W / 2, -H / 2, W, H);
    ctx.restore();
    if (hasCtxFilter) ctx.filter = 'none'; else pixelFilter(ctx, cw, ch, f);
    if (f.tint) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = f.tint; ctx.fillRect(0, 0, cw, ch);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  const E = {
    dlg: $('#editor'), cancel: $('#edCancel'), reset: $('#edReset'), save: $('#edSave'),
    stage: $('#edStage'), box: $('#edBox'), canvas: $('#edCanvas'), crop: $('#crop'),
    rot: $('#edRot'), flip: $('#edFlip'), ratios: $('#edRatios'), filters: $('#filterList'),
    sheet: $('#saveSheet'), copy: $('#saveCopy'), replace: $('#saveReplace'), saveCancel: $('#saveCancel')
  };
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const RATIOS = [['free', 'Libre'], ['orig', 'Original'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4'], [16 / 9, '16:9'], [9 / 16, '9:16']];
  let ed = null, edRaf = 0, cd = null;

  const orientedSize = () => (ed.rot % 2 ? [ed.H, ed.W] : [ed.W, ed.H]);
  function lockFactor() {
    if (ed.ratio === 'free') return 0;
    const [ow, oh] = orientedSize();
    const r = ed.ratio === 'orig' ? ow / oh : ed.ratio;
    return r * oh / ow;
  }
  function isDirty() {
    const c = ed.crop, a = ed.adj;
    return ed.rot !== 0 || ed.flip || a.b || a.c || a.s || ed.filter !== 'none' || c.w < 0.999 || c.h < 0.999 || c.x > 0.001 || c.y > 0.001;
  }

  function layoutBox() {
    if (!ed) return;
    const [ow, oh] = orientedSize();
    const aw = E.stage.clientWidth - 56, ah = E.stage.clientHeight - 56;
    if (aw <= 0 || ah <= 0) return;
    const s = Math.min(aw / ow, ah / oh);
    E.box.style.width = Math.round(ow * s) + 'px';
    E.box.style.height = Math.round(oh * s) + 'px';
  }
  function updateCropUI() {
    const c = ed.crop;
    E.crop.style.left = (c.x * 100) + '%'; E.crop.style.top = (c.y * 100) + '%';
    E.crop.style.width = (c.w * 100) + '%'; E.crop.style.height = (c.h * 100) + '%';
  }
  function schedulePreview() {
    if (edRaf) return;
    edRaf = requestAnimationFrame(() => {
      edRaf = 0;
      if (!ed) return;
      const [ow, oh] = orientedSize();
      renderTo(E.canvas, ed.img, ed.W, ed.H, ed, FULL, Math.min(1, 1400 / Math.max(ow, oh)));
    });
  }
  function renderThumbs() {
    if (!ed) return;
    const [ow, oh] = orientedSize();
    const reg = ow > oh ? { x: (1 - oh / ow) / 2, y: 0, w: oh / ow, h: 1 } : { x: 0, y: (1 - ow / oh) / 2, w: 1, h: ow / oh };
    const scale = 128 / Math.min(ow, oh);
    E.filters.querySelectorAll('canvas').forEach((c, i) => {
      renderTo(c, ed.img, ed.W, ed.H, { rot: ed.rot, flip: ed.flip, adj: { b: 0, c: 0, s: 0 }, filter: FILTERS[i].id }, reg, scale);
    });
  }

  function setTab(name) {
    $$('#edPanel .tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
    $$('#edPanel .tool').forEach(t => { t.hidden = t.dataset.tool !== name; });
    E.crop.classList.toggle('locked', name !== 'crop');
    if (name === 'filters') renderThumbs();
  }
  $$('#edPanel .tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function syncEditorUI() {
    const a = ed.adj;
    $$('[data-adj]').forEach(i => { i.value = a[i.dataset.adj]; });
    $('#oB').textContent = a.b; $('#oC').textContent = a.c; $('#oS').textContent = a.s;
    $$('#edRatios button').forEach((b, i) => b.setAttribute('aria-pressed', String(RATIOS[i][0] === ed.ratio)));
    $$('#filterList .fbtn').forEach((b, i) => b.setAttribute('aria-pressed', String(FILTERS[i].id === ed.filter)));
    updateCropUI();
  }

  // Chips de proporción y botones de filtro (se crean una sola vez)
  RATIOS.forEach(([val, label]) => {
    const b = document.createElement('button'); b.textContent = label;
    b.addEventListener('click', () => {
      if (!ed) return;
      ed.ratio = val;
      if (val !== 'free') ed.crop = centeredRect(lockFactor());
      syncEditorUI();
    });
    E.ratios.append(b);
  });
  FILTERS.forEach(fl => {
    const b = document.createElement('button'); b.className = 'fbtn';
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const n = document.createElement('span'); n.textContent = fl.name;
    b.append(c, n);
    b.addEventListener('click', () => { if (!ed) return; ed.filter = fl.id; syncEditorUI(); schedulePreview(); });
    E.filters.append(b);
  });

  E.rot.addEventListener('click', () => {
    if (!ed) return;
    ed.rot = (ed.rot + 1) % 4;
    ed.crop = ed.ratio === 'free' ? { ...FULL } : centeredRect(lockFactor());
    layoutBox(); schedulePreview(); renderThumbs(); syncEditorUI();
  });
  E.flip.addEventListener('click', () => {
    if (!ed) return;
    ed.flip = !ed.flip;
    ed.crop.x = 1 - ed.crop.x - ed.crop.w;
    schedulePreview(); renderThumbs(); updateCropUI();
  });
  $$('[data-adj]').forEach(inp => inp.addEventListener('input', () => {
    if (!ed) return;
    const k = inp.dataset.adj;
    ed.adj[k] = Number(inp.value);
    $('#o' + k.toUpperCase()).textContent = inp.value;
    schedulePreview();
  }));
  E.reset.addEventListener('click', () => {
    if (!ed) return;
    Object.assign(ed, { rot: 0, flip: false, crop: { ...FULL }, ratio: 'free', filter: 'none', adj: { b: 0, c: 0, s: 0 } });
    layoutBox(); syncEditorUI(); schedulePreview(); renderThumbs();
  });

  /* Recorte: mover el recuadro o arrastrar una esquina */
  E.crop.addEventListener('pointerdown', e => {
    if (!ed || E.crop.classList.contains('locked')) return;
    const r = E.box.getBoundingClientRect(), c = ed.crop;
    const h = e.target.closest && e.target.closest('.handle');
    if (h) {
      const k = h.dataset.c;
      cd = { id: e.pointerId, mode: 'corner', r, ax: k.includes('w') ? c.x + c.w : c.x, ay: k.includes('n') ? c.y + c.h : c.y };
    } else {
      cd = { id: e.pointerId, mode: 'move', r, sx: e.clientX, sy: e.clientY, c0: { ...c } };
    }
    try { E.crop.setPointerCapture(e.pointerId); } catch { /* nada */ }
    e.preventDefault();
  });
  E.crop.addEventListener('pointermove', e => {
    if (!cd || e.pointerId !== cd.id || !ed) return;
    const r = cd.r;
    if (cd.mode === 'move') {
      const dx = (e.clientX - cd.sx) / r.width, dy = (e.clientY - cd.sy) / r.height;
      ed.crop = { x: clampN(cd.c0.x + dx, 0, 1 - cd.c0.w), y: clampN(cd.c0.y + dy, 0, 1 - cd.c0.h), w: cd.c0.w, h: cd.c0.h };
    } else {
      const px = clampN((e.clientX - r.left) / r.width, 0, 1), py = clampN((e.clientY - r.top) / r.height, 0, 1);
      ed.crop = cornerRect(cd.ax, cd.ay, px, py, lockFactor());
    }
    updateCropUI();
  });
  const endCrop = e => { if (cd && e.pointerId === cd.id) cd = null; };
  E.crop.addEventListener('pointerup', endCrop);
  E.crop.addEventListener('pointercancel', endCrop);

  /* Abrir, cancelar y cerrar */
  async function openEditor(it) {
    if (!it || it.type !== 'photo') return;
    const img = new Image();
    img.src = urlFor(it);
    try { await img.decode(); } catch { toast('No se pudo abrir la foto'); return; }
    ed = {
      item: it, img, W: img.naturalWidth, H: img.naturalHeight, rot: 0, flip: false,
      crop: { ...FULL }, ratio: 'free', adj: { b: 0, c: 0, s: 0 }, filter: 'none', discardArmed: false, saving: false
    };
    syncEditorUI(); setTab('crop');
    E.sheet.hidden = true;
    E.dlg.showModal();
    layoutBox(); schedulePreview(); renderThumbs();
  }
  function closeEditor() {
    E.sheet.hidden = true;
    resetConfirm(E.replace, 'Reemplazar la original');
    ed = null;
    if (E.dlg.open) E.dlg.close();
    E.canvas.width = 1; E.canvas.height = 1;
  }
  let discardTimer;
  function tryCancel() {
    if (!ed) return;
    if (isDirty() && !ed.discardArmed) {
      ed.discardArmed = true;
      toast('Hay cambios sin guardar. Toca otra vez para descartarlos', 3000);
      clearTimeout(discardTimer);
      discardTimer = setTimeout(() => { if (ed) ed.discardArmed = false; }, 3000);
      return;
    }
    closeEditor();
  }
  E.cancel.addEventListener('click', tryCancel);
  E.dlg.addEventListener('cancel', e => { e.preventDefault(); if (!E.sheet.hidden) E.sheet.hidden = true; else tryCancel(); });
  addEventListener('resize', () => { if (ed) layoutBox(); });

  /* Guardar */
  async function exportBlob() {
    const [ow, oh] = orientedSize();
    const cw = ow * ed.crop.w, ch = oh * ed.crop.h;
    const scale = Math.min(1, 6000 / Math.max(cw, ch));
    const c = document.createElement('canvas');
    renderTo(c, ed.img, ed.W, ed.H, ed, ed.crop, scale);
    const type = /^image\/(jpeg|png|webp)$/.test(ed.item.mime) ? ed.item.mime : 'image/jpeg';
    const blob = await new Promise(r => c.toBlob(r, type, 0.92));
    c.width = c.height = 1;
    return blob;
  }
  E.save.addEventListener('click', () => { if (ed) E.sheet.hidden = false; });
  E.saveCancel.addEventListener('click', () => { E.sheet.hidden = true; resetConfirm(E.replace, 'Reemplazar la original'); });
  E.copy.addEventListener('click', () => doSave('copy'));
  E.replace.addEventListener('click', () => {
    if (!confirmTwice(E.replace, 'Reemplazar la original', 'Toca otra vez: no se puede deshacer')) return;
    doSave('replace');
  });

  async function doSave(mode) {
    const cur = ed;
    if (!cur || cur.saving) return;
    cur.saving = true;
    E.copy.disabled = E.replace.disabled = true;
    toast('Guardando…', 10000);
    try {
      const blob = await exportBlob();
      if (!blob) throw new Error('No se pudo crear la imagen');
      const it = cur.item, type = blob.type;
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const base = it.name.replace(/\.[^.]+$/, '');
      const [dbn, st] = it.src === 'cam' ? [CAM_DB, CAM_STORE] : [OWN_DB, OWN_STORE];
      let key;
      if (mode === 'copy') {
        const id = await writeOp(dbn, st, s => s.add({ type: 'photo', blob, mime: type, size: blob.size, created: Date.now(), name: `${base}_editada.${ext}` }));
        key = it.src + ':' + id;
      } else {
        await writeOp(dbn, st, s => s.put({ id: it.id, type: 'photo', blob, mime: type, size: blob.size, created: it.created, name: `${base}.${ext}` }));
        dropUrl(it.key);
        key = it.key;
      }
      closeEditor();
      await load();
      renderGrid();
      if (el.viewer.open) {
        const idx = list.findIndex(i => i.key === key);
        if (idx >= 0) { viewIndex = idx; renderSlides(); updateViewerUI(); } else el.viewer.close();
      }
      toast(mode === 'copy' ? 'Copia guardada' : 'Foto actualizada');
    } catch (err) {
      cur.saving = false;
      E.copy.disabled = E.replace.disabled = false;
      toast('No se pudo guardar la foto. Revisa el espacio del teléfono.', 3800);
    }
    E.copy.disabled = E.replace.disabled = false;
  }

  el.vEdit.addEventListener('click', () => openEditor(list[viewIndex]));

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
