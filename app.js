/* Mom's TV - iPad web app
   Videos live in this app's own storage on the iPad (IndexedDB), never on GitHub.
   Rob adds them through the hidden "Add shows" screen:
   press and hold the MOM'S TV nameplate for 3 seconds. */
'use strict';

const APP_VERSION = '1.0';
const PER_PAGE = { shows: 6, seasons: 8, episodes: 6 };
const NAME_RE = /^(.+?) - S(\d{1,3})E(\d{1,4}) - (.+)\.(mp4|m4v|jpe?g)$/i;
const HOLD_MS = 3000;
const TINTS = ['#4c5d4b', '#5b4c3d', '#43516a', '#5a5340', '#504358', '#3d5853'];

const ICON = {
  play: '<svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#17110c"></circle><path d="M10 8l6 4-6 4z" fill="#f6edcf"></path></svg>',
  thumbPlay: '<svg class="play" width="54" height="54" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="rgba(23,17,12,0.65)"></circle><path d="M10 8l6 4-6 4z" fill="#f6edcf"></path></svg>',
  left: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#17110c" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>',
  right: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#17110c" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>',
  bigPlay: '<svg width="70" height="70" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l12 7-12 7z" fill="#17110c"></path></svg>',
  bigPause: '<svg width="64" height="64" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="#17110c"></rect><rect x="14" y="5" width="4" height="14" rx="1" fill="#17110c"></rect></svg>'
};

/* ================================================================
   Storage (IndexedDB)
   episodes: {id, show, season, ep, title, size, added}
   videos:   id -> video Blob
   thumbs:   id -> jpg Blob
   progress: {id, pos, dur, seen, finished, updated}
   ================================================================ */

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('momstv', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('episodes')) d.createObjectStore('episodes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos');
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
      if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(stores, mode, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    const req = work(t);
    if (req && typeof req === 'object' && 'onsuccess' in req) {
      req.onsuccess = () => { result = req.result; };
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage was interrupted'));
  });
}

const dbGetAll = (store) => runTx(store, 'readonly', t => t.objectStore(store).getAll());
const dbGet = (store, key) => runTx(store, 'readonly', t => t.objectStore(store).get(key));
const dbPut = (store, value, key) => runTx(store, 'readwrite', t =>
  key === undefined ? t.objectStore(store).put(value) : t.objectStore(store).put(value, key));

function dbDeleteEpisode(id) {
  return runTx(['episodes', 'videos', 'thumbs', 'progress'], 'readwrite', t => {
    t.objectStore('episodes').delete(id);
    t.objectStore('videos').delete(id);
    t.objectStore('thumbs').delete(id);
    t.objectStore('progress').delete(id);
  });
}

/* ================================================================
   Library
   ================================================================ */

let episodes = [];
let byId = new Map();
let library = [];            // [{name, seasons: [{n, eps: [...]}]}]
let progress = new Map();    // id -> progress record
const thumbUrls = new Map(); // id -> object URL (or null if none)

const sortKey = (name) => name.replace(/^the\s+/i, '').toLowerCase();

function buildLibrary() {
  byId = new Map(episodes.map(e => [e.id, e]));
  const shows = new Map();
  for (const e of episodes) {
    if (!shows.has(e.show)) shows.set(e.show, new Map());
    const seasons = shows.get(e.show);
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push(e);
  }
  library = [...shows.entries()]
    .map(([name, seasons]) => ({
      name,
      seasons: [...seasons.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, eps]) => ({ n, eps: eps.sort((a, b) => a.ep - b.ep) }))
    }))
    .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
}

async function loadLibrary() {
  episodes = await dbGetAll('episodes');
  const recs = await dbGetAll('progress');
  progress = new Map(recs.map(r => [r.id, r]));
  buildLibrary();
}

const findShow = (name) => library.find(s => s.name === name);

function showEpisodes(show) {
  const all = [];
  for (const s of show.seasons) all.push(...s.eps);
  return all;
}

function nextEpisode(ep) {
  const show = findShow(ep.show);
  if (!show) return null;
  const all = showEpisodes(show);
  const i = all.findIndex(e => e.id === ep.id);
  return (i >= 0 && i < all.length - 1) ? all[i + 1] : null;
}

function showInfo(show) {
  if (show.seasons.length > 1) return show.seasons.length + ' seasons';
  const n = show.seasons[0].eps.length;
  return n + (n === 1 ? ' episode' : ' episodes');
}

function epLabel(ep) {
  const show = findShow(ep.show);
  if (show && show.seasons.length > 1) return 'Season ' + ep.season + ', Episode ' + ep.ep;
  return 'Episode ' + ep.ep;
}

// Most recent thing she watched: resume it, or the next episode if she finished it.
function keepWatching() {
  let best = null;
  for (const r of progress.values()) {
    if (byId.has(r.id) && (!best || r.updated > best.updated)) best = r;
  }
  if (!best) return null;
  const ep = byId.get(best.id);
  if (best.finished) {
    const next = nextEpisode(ep);
    return next ? { ep: next } : null;
  }
  return { ep };
}

async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  let url = null;
  try {
    const blob = await dbGet('thumbs', id);
    if (blob) url = URL.createObjectURL(blob);
  } catch (e) { /* no thumbnail */ }
  thumbUrls.set(id, url);
  return url;
}

function forgetThumb(id) {
  const url = thumbUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbUrls.delete(id);
}

/* ================================================================
   Little helpers
   ================================================================ */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const svg = (markup) => h('span', { html: markup, style: 'display:contents' });

function gb(bytes) {
  if (!bytes && bytes !== 0) return '?';
  if (bytes < 1e9) return Math.round(bytes / 1e6) + ' MB';
  return (bytes / 1e9).toFixed(1) + ' GB';
}

function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hr = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return hr ? hr + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}

const isStandalone = () => window.navigator.standalone === true ||
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

/* ================================================================
   Screens
   ================================================================ */

const $screen = document.getElementById('screen');
const $back = document.getElementById('back');
const $plate = document.getElementById('plate');
const $stage = document.getElementById('stage');

const state = {
  view: 'shows',          // shows | seasons | episodes | admin
  show: null,
  season: null,
  page: { shows: 0, seasons: 0, episodes: 0 }
};

function fill(viewClass, kids) {
  $screen.className = 'screen v-' + viewClass;
  $screen.replaceChildren(...kids.filter(Boolean));
}

function setBack(visible) {
  $back.classList.toggle('hidden', !visible);
}

function paginate(list, key, size, moreLabel) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(Math.max(0, state.page[key]), pages - 1);
  state.page[key] = p;
  const items = list.slice(p * size, p * size + size);
  if (pages === 1) return { items, pager: null };
  const pager = h('div', { class: 'pager' },
    h('button', { class: 'pg-btn', type: 'button', disabled: p === 0, onclick: () => { state.page[key]--; render(); } },
      svg(ICON.left), 'Earlier'),
    h('span', { class: 'pg-info' }, 'Page ' + (p + 1) + ' of ' + pages),
    h('button', { class: 'pg-btn', type: 'button', disabled: p === pages - 1, onclick: () => { state.page[key]++; render(); } },
      moreLabel, svg(ICON.right))
  );
  return { items, pager };
}

function render() {
  if (state.view === 'admin') return renderAdmin();
  const show = state.show ? findShow(state.show) : null;
  if (state.view !== 'shows' && !show) state.view = 'shows';
  if (state.view === 'episodes' && !show.seasons.some(s => s.n === state.season)) state.view = 'shows';
  if (state.view === 'seasons') return renderSeasons(show);
  if (state.view === 'episodes') return renderEpisodes(show);
  return renderShows();
}

function renderShows() {
  setBack(false);
  const hdr = h('div', { class: 'hdr' }, h('h1', null, "Mom's Shows"),
    library.length ? h('span', { class: 'hint' }, 'Tap a show') : null);

  if (!library.length) {
    const msg = isStandalone()
      ? h('div', { class: 'empty' }, 'No shows yet.', h('br'), 'Rob will add some soon.')
      : h('div', { class: 'empty' }, 'To set up Mom’s TV:', h('br'),
          'tap the Share button, then', h('br'), '“Add to Home Screen”.');
    return fill('shows', [hdr, msg]);
  }

  let keep = null;
  const kw = keepWatching();
  if (kw) {
    keep = h('button', { class: 'keep', type: 'button', onclick: () => playEpisode(kw.ep) },
      svg(ICON.play),
      h('span', { class: 'keep-text' },
        h('span', { class: 'keep-label' }, 'Keep watching'),
        h('span', { class: 'keep-title' }, kw.ep.show),
        h('span', { class: 'keep-sub' }, epLabel(kw.ep) + ' · ' + kw.ep.title)));
  }

  const { items, pager } = paginate(library, 'shows', PER_PAGE.shows, 'More shows');
  const grid = h('div', { class: 'grid shows-grid' }, items.map(s =>
    h('button', { class: 'tile', type: 'button', onclick: () => openShow(s.name) },
      h('span', { class: 'tile-name' }, s.name),
      h('span', { class: 'tile-info' }, showInfo(s)))));

  fill('shows', [hdr, keep, grid, pager]);
}

function renderSeasons(show) {
  setBack(true);
  const hdr = h('div', { class: 'hdr' }, h('h1', null, show.name), h('span', { class: 'hint' }, 'Pick a season'));
  const { items, pager } = paginate(show.seasons, 'seasons', PER_PAGE.seasons, 'More seasons');
  const grid = h('div', { class: 'grid seasons-grid' }, items.map(s =>
    h('button', { class: 'tile season-tile', type: 'button', onclick: () => openSeason(s.n) },
      h('span', { class: 'lbl' }, 'Season'),
      h('span', { class: 'num' }, String(s.n)),
      h('span', { class: 'eps' }, s.eps.length + (s.eps.length === 1 ? ' episode' : ' episodes')))));
  fill('seasons', [hdr, grid, pager]);
}

function renderEpisodes(show) {
  setBack(true);
  const season = show.seasons.find(s => s.n === state.season);
  const hdr = h('div', { class: 'hdr' }, h('h1', null, show.name),
    show.seasons.length > 1 ? h('span', { class: 'hint' }, 'Season ' + season.n) : null);

  const { items, pager } = paginate(season.eps, 'episodes', PER_PAGE.episodes, 'More episodes');
  const grid = h('div', { class: 'grid eps-grid' }, items.map((ep, i) => {
    const rec = progress.get(ep.id);
    const img = h('img', { alt: '' });
    img.style.display = 'none';
    thumbUrl(ep.id).then(url => { if (url) { img.src = url; img.style.display = ''; } });
    const thumb = h('span', { class: 'thumb', style: 'background:' + TINTS[(ep.ep + i) % TINTS.length] },
      img, svg(ICON.thumbPlay));
    if (rec && rec.seen) thumb.append(h('span', { class: 'seen' }, 'Seen it'));
    if (rec && !rec.finished && rec.dur && rec.pos > 15) {
      const pct = Math.min(100, Math.max(3, (rec.pos / rec.dur) * 100));
      thumb.append(h('span', { class: 'parttrack' }, h('span', { class: 'partbar', style: 'display:block;width:' + pct + '%' })));
    }
    return h('button', { class: 'ep-card', type: 'button', onclick: () => playEpisode(ep) },
      thumb,
      h('span', { class: 'ep-num' }, 'Episode ' + ep.ep),
      h('span', { class: 'ep-title' }, ep.title));
  }));
  fill('episodes', [hdr, grid, pager]);
}

function openShow(name) {
  const show = findShow(name);
  if (!show) return;
  state.show = name;
  if (show.seasons.length === 1) return openSeason(show.seasons[0].n);
  state.view = 'seasons';
  state.page.seasons = 0;
  render();
}

// Open a season on the page with the episode she watched most recently.
function openSeason(n) {
  state.season = n;
  state.view = 'episodes';
  state.page.episodes = 0;
  const show = findShow(state.show);
  const season = show && show.seasons.find(s => s.n === n);
  if (season) {
    let bestIdx = -1, bestTime = 0;
    season.eps.forEach((ep, i) => {
      const r = progress.get(ep.id);
      if (r && r.updated > bestTime) { bestTime = r.updated; bestIdx = i; }
    });
    if (bestIdx >= 0) state.page.episodes = Math.floor(bestIdx / PER_PAGE.episodes);
  }
  render();
}

function goBack() {
  if (state.view === 'episodes') {
    const show = findShow(state.show);
    state.view = (show && show.seasons.length > 1) ? 'seasons' : 'shows';
  } else {
    state.view = 'shows';
  }
  render();
}

$back.addEventListener('click', goBack);

/* ================================================================
   Player
   ================================================================ */

const $player = document.getElementById('player');
const $video = document.getElementById('video');
const $pPlay = document.getElementById('pPlay');
const $pTitle = document.getElementById('pTitle');
const $pFill = document.getElementById('pFill');
const $pTime = document.getElementById('pTime');
const $pMsg = document.getElementById('pMsg');

let current = null;      // episode being played
let currentUrl = null;
let resumeAt = 0;
let lastSave = 0;
let hideTimer = null;

function showControls() {
  $player.classList.add('show-ctl');
  clearTimeout(hideTimer);
  if (!$video.paused) hideTimer = setTimeout(() => $player.classList.remove('show-ctl'), 4000);
}

function updatePlayIcon() {
  $pPlay.innerHTML = $video.paused ? ICON.bigPlay : ICON.bigPause;
}

function playerMessage(text) {
  $pMsg.textContent = text;
  $player.classList.add('has-msg', 'show-ctl');
}

async function playEpisode(ep) {
  // Calling load() during the tap lets the iPad start the video with sound a moment later.
  try { $video.load(); } catch (e) { /* ignore */ }

  // Coming back from the player always lands on this episode's list.
  const show = findShow(ep.show);
  state.show = ep.show;
  state.season = ep.season;
  state.view = 'episodes';
  if (show) {
    const season = show.seasons.find(s => s.n === ep.season);
    const idx = season ? season.eps.findIndex(e => e.id === ep.id) : 0;
    state.page.episodes = Math.floor(Math.max(0, idx) / PER_PAGE.episodes);
  }

  current = ep;
  lastSave = 0;
  $pTitle.textContent = epLabel(ep) + ' · ' + ep.title;
  $pFill.style.width = '0%';
  $pTime.textContent = '';
  $player.classList.remove('has-msg');
  $player.classList.add('open', 'show-ctl');
  updatePlayIcon();

  let blob = null;
  try { blob = await dbGet('videos', ep.id); } catch (e) { /* handled below */ }
  if (current !== ep) return;
  if (!blob) { playerMessage('This episode is missing.\nAsk Rob to add it again.'); return; }

  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);

  const rec = progress.get(ep.id);
  resumeAt = (rec && !rec.finished && rec.pos > 15 && (!rec.dur || rec.pos < rec.dur - 20)) ? rec.pos : 0;

  $video.src = currentUrl;
  try {
    await $video.play();
  } catch (e) {
    // The iPad wants one more tap: leave the big Play button showing.
    updatePlayIcon();
    $player.classList.add('show-ctl');
  }
}

function saveProgress(force) {
  if (!current) return;
  const dur = $video.duration;
  if (!dur || !isFinite(dur)) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const pos = $video.currentTime;
  const old = progress.get(current.id) || {};
  const nearEnd = pos >= dur * 0.95;
  const rec = {
    id: current.id,
    pos: nearEnd ? 0 : pos,
    dur,
    seen: !!old.seen || pos >= dur * 0.9,
    finished: nearEnd,
    updated: now
  };
  progress.set(rec.id, rec);
  dbPut('progress', rec).catch(() => {});
}

function markFinished() {
  if (!current) return;
  const rec = { id: current.id, pos: 0, dur: $video.duration || 0, seen: true, finished: true, updated: Date.now() };
  progress.set(rec.id, rec);
  dbPut('progress', rec).catch(() => {});
}

function closePlayer() {
  $video.pause();
  $video.removeAttribute('src');
  try { $video.load(); } catch (e) { /* ignore */ }
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  current = null;
  clearTimeout(hideTimer);
  $player.classList.remove('open', 'show-ctl', 'has-msg');
  render();
}

$video.addEventListener('loadedmetadata', () => {
  if (resumeAt > 0 && resumeAt < $video.duration) {
    try { $video.currentTime = resumeAt; } catch (e) { /* ignore */ }
  }
  resumeAt = 0;
});

$video.addEventListener('timeupdate', () => {
  const d = $video.duration;
  if (d && isFinite(d)) {
    $pFill.style.width = (($video.currentTime / d) * 100) + '%';
    $pTime.textContent = clock($video.currentTime) + ' of ' + clock(d);
  }
  saveProgress(false);
});

$video.addEventListener('play', () => { updatePlayIcon(); showControls(); });
$video.addEventListener('pause', () => { updatePlayIcon(); showControls(); saveProgress(true); });
$video.addEventListener('ended', () => { markFinished(); closePlayer(); });
$video.addEventListener('error', () => {
  if (current && $video.getAttribute('src')) playerMessage('This episode won’t play.\nAsk Rob to look at it.');
});

$pPlay.addEventListener('click', (e) => {
  e.stopPropagation();
  if ($video.paused) $video.play().catch(() => {}); else $video.pause();
  showControls();
});

document.getElementById('pRew').addEventListener('click', (e) => {
  e.stopPropagation();
  $video.currentTime = Math.max(0, $video.currentTime - 30);
  showControls();
});

document.getElementById('pBack').addEventListener('click', (e) => {
  e.stopPropagation();
  saveProgress(true);
  closePlayer();
});

// Tapping anywhere on the picture brings the buttons back.
$player.addEventListener('click', (e) => {
  if (e.target === $video || e.target.id === 'pctl') {
    if ($player.classList.contains('show-ctl') && !$video.paused) {
      clearTimeout(hideTimer);
      $player.classList.remove('show-ctl');
    } else {
      showControls();
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress(true);
});
window.addEventListener('pagehide', () => saveProgress(true));

/* ================================================================
   Rob's hidden "Add shows" screen
   Press and hold the MOM'S TV nameplate for 3 seconds.
   ================================================================ */

let holdTimer = null;
$plate.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(openAdmin, HOLD_MS);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(t =>
  $plate.addEventListener(t, () => clearTimeout(holdTimer)));
$plate.addEventListener('contextmenu', (e) => e.preventDefault());

const $picker = document.getElementById('picker');
let importing = false;
let adminMessage = null;   // {kind, text}

function openAdmin() {
  if ($player.classList.contains('open')) return;
  state.view = 'admin';
  adminMessage = null;
  render();
}

async function renderAdmin() {
  setBack(true);
  const hdr = h('div', { class: 'hdr' }, h('h1', null, 'Add shows'), h('span', { class: 'hint' }, 'For Rob'));
  const body = h('div', { class: 'admin' });

  if (!isStandalone()) {
    body.append(h('div', { class: 'a-box bad' },
      'You’re in Safari, not the Mom’s TV icon. Shows added here will NOT appear in the icon. ' +
      'First tap Share → Add to Home Screen, then open Mom’s TV from the Home Screen and add shows there.'));
  }

  const chooseBtn = h('label', { class: 'a-btn' + (importing ? ' busy' : ''), for: 'picker' }, 'Choose files to add');
  const doneBtn = h('button', { class: 'a-btn small', type: 'button', onclick: () => { if (!importing) { state.view = 'shows'; render(); } } }, 'Done');
  body.append(h('div', { class: 'a-actions' }, chooseBtn, doneBtn));
  body.append(h('div', { class: 'a-note' },
    'In the file window: open your USB drive, tap Select (top right), select all the .mp4 and .jpg files, then tap Open. ' +
    'Keep the iPad awake until it says it’s finished.'));

  const status = h('div', { id: 'aStatus' });
  if (adminMessage) status.append(h('div', { class: 'a-box ' + (adminMessage.kind || '') }, ...adminMessage.text.split('\n').flatMap((line, i) => i ? [h('br'), line] : [line])));
  body.append(status);

  const storage = h('div', { class: 'a-note' }, 'Checking space…');
  body.append(storage);
  body.append(h('div', { class: 'a-box' },
    'Important: never delete the Mom’s TV icon from the Home Screen. Deleting it erases every show stored in it.'));

  body.append(h('div', { class: 'a-h2' }, 'What’s on Mom’s TV'));
  if (!library.length) body.append(h('div', { class: 'a-note' }, 'Nothing yet.'));
  for (const show of library) {
    for (const season of show.seasons) {
      const bytes = season.eps.reduce((sum, e) => sum + (e.size || 0), 0);
      body.append(h('div', { class: 'a-row' },
        h('span', null, show.name + ' — Season ' + season.n + ' — ' + season.eps.length + ' episodes — ' + gb(bytes)),
        h('button', { class: 'a-btn small danger', type: 'button', onclick: () => removeSeason(show.name, season.n) }, 'Remove')));
    }
  }
  body.append(h('div', { class: 'a-note' }, 'Mom’s TV version ' + APP_VERSION));

  fill('admin', [hdr, body]);

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      storage.textContent = 'Using ' + gb(est.usage) + '. Room for about ' + gb(Math.max(0, est.quota - est.usage)) + ' more.' +
        (persisted ? ' Storage is protected.' : '');
    } else {
      storage.textContent = '';
    }
  } catch (e) {
    storage.textContent = '';
  }
}

function setStatus(text, pct) {
  const el = document.getElementById('aStatus');
  if (!el) return;
  const bar = h('div', { class: 'a-prog' }, h('div', { style: 'width:' + (pct || 0) + '%' }));
  el.replaceChildren(h('div', null, text), bar);
}

$picker.addEventListener('change', async () => {
  const files = [...$picker.files];
  $picker.value = '';
  if (!files.length || importing) return;
  await importFiles(files);
});

async function importFiles(files) {
  importing = true;
  render();

  // Ask the iPad to protect this app's storage from being cleared.
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }

  const groups = new Map();
  const skipped = [];
  for (const f of files) {
    const name = f.name.normalize('NFC');
    const m = name.match(NAME_RE);
    if (!m) { skipped.push(name); continue; }
    const key = name.replace(/\.[^.]+$/, '').toLowerCase();
    const g = groups.get(key) || {
      show: m[1].trim(), season: parseInt(m[2], 10), ep: parseInt(m[3], 10), title: m[4].trim()
    };
    if (/^jpe?g$/i.test(m[5])) g.jpg = f; else g.video = f;
    groups.set(key, g);
  }

  const jobs = [...groups.values()];
  let added = 0, thumbsOnly = 0;
  const failed = [];
  let stopReason = null;

  for (let i = 0; i < jobs.length; i++) {
    const g = jobs[i];
    const id = g.show + '|' + g.season + '|' + g.ep;
    const label = g.show + ' S' + String(g.season).padStart(2, '0') + 'E' + String(g.ep).padStart(2, '0');
    setStatus('Adding ' + (i + 1) + ' of ' + jobs.length + ': ' + label + '…  Keep this screen open.', (i / jobs.length) * 100);

    try {
      if (!g.video) {
        // A thumbnail on its own only counts if that episode is already here.
        if (g.jpg && byId.has(id)) {
          await dbPut('thumbs', new Blob([g.jpg], { type: 'image/jpeg' }), id);
          forgetThumb(id);
          thumbsOnly++;
        } else {
          skipped.push(g.jpg ? g.jpg.name : label);
        }
        continue;
      }
      const video = g.video.type ? g.video : new Blob([g.video], { type: 'video/mp4' });
      await dbPut('videos', video, id);
      if (g.jpg) await dbPut('thumbs', new Blob([g.jpg], { type: 'image/jpeg' }), id);
      forgetThumb(id);
      await dbPut('episodes', { id, show: g.show, season: g.season, ep: g.ep, title: g.title, size: g.video.size, added: Date.now() });
      added++;
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'QuotaExceededError' || /quota/i.test(String(e && e.message))) {
        stopReason = 'The iPad ran out of room for videos. Remove a season or free up space, then try again.';
        failed.push(label);
        break;
      }
      failed.push(label + ' (' + (name || 'error') + ')');
    }
  }

  await loadLibrary();
  importing = false;

  const lines = [];
  lines.push('Finished. Added ' + added + ' episode' + (added === 1 ? '' : 's') + '.');
  if (thumbsOnly) lines.push('Updated ' + thumbsOnly + ' thumbnail' + (thumbsOnly === 1 ? '' : 's') + '.');
  if (stopReason) lines.push(stopReason);
  if (failed.length) lines.push('Didn’t work: ' + failed.join(', '));
  if (skipped.length) lines.push('Skipped (name not in the right pattern): ' + skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? ' and ' + (skipped.length - 8) + ' more' : ''));
  adminMessage = { kind: (failed.length || stopReason) ? 'bad' : 'good', text: lines.join('\n') };
  render();
}

async function removeSeason(showName, n) {
  if (importing) return;
  if (!confirm('Remove ' + showName + ', Season ' + n + ' from Mom’s TV?\nThe videos will be deleted from this iPad.')) return;
  const show = findShow(showName);
  const season = show && show.seasons.find(s => s.n === n);
  if (!season) return;
  for (const ep of season.eps) {
    try { await dbDeleteEpisode(ep.id); } catch (e) { /* keep going */ }
    forgetThumb(ep.id);
  }
  await loadLibrary();
  adminMessage = { kind: 'good', text: 'Removed ' + showName + ', Season ' + n + '.' };
  render();
}

/* ================================================================
   Fit the cabinet to the screen (landscape or portrait)
   ================================================================ */

function fit() {
  const w = window.innerWidth, hgt = window.innerHeight;
  const portrait = hgt > w;
  const was = document.body.classList.contains('portrait');
  document.body.classList.toggle('portrait', portrait);
  const W = portrait ? 820 : 1180, H = portrait ? 1180 : 820;
  const scale = Math.min(w / W, hgt / H);
  $stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
  return was !== portrait;
}

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', () => setTimeout(fit, 250));

/* ================================================================
   Start
   ================================================================ */

async function start() {
  fit();
  try {
    db = await openDB();
    await loadLibrary();
  } catch (e) {
    fill('shows', [h('div', { class: 'empty' }, 'Mom’s TV couldn’t open its storage.', h('br'), 'Close it and open it again.')]);
    return;
  }
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
