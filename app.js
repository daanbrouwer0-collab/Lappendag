// Lappendag Rave Afterparty - Audio Engine
// Track catalog + mix points come from tracks.json (needs HTTP(S), not file://).

const TRACK_DIR = 'Lap-set';
const TRACK_PREFIX = 'Lap_';
const MY_LIST_KEY = 'lappendag-my-list';

const MIX_MIN_SEC = 2;
const MIX_MAX_SEC = 12;
const MIX_DEFAULT_SEC = 6;
/** Auto never picks shorter than this once mix points are ready. */
const AUTO_MIX_MIN_SEC = 3.5;

let tracks = [];
let myListNames = loadMyList();
let activeTab = 'all'; // 'all' | 'mylist'
let shuffleOn = true;
let mixOn = true;
let autoMixSec = null;
let autoMixKey = null;
let autoMixPreparing = null;
let plannedNextIndex = -1;
let isMixing = false;
let pendingMixIndex = -1;
let mixBlendT = 0;
let mixStartOutPercent = 0;
/** Outgoing audio.currentTime when the mix fade started. */
let mixAudioT0 = 0;
/** Mix fade length in seconds (audio-clock, not rAF). */
let mixDurationSec = 0;

function easeMix(t) {
  const x = Math.min(1, Math.max(0, t));
  // Smootherstep — soft start/end, no harsh jump at the handoff
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// DOM Elements — dual decks; `audio` always points at the active one
const audioA = document.getElementById('audioPlayer');
const audioB = document.getElementById('audioPlayerB');
let audio = audioA;
let audioIncoming = audioB;
const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const randomBtn = document.getElementById('randomBtn');
const mixBtn = document.getElementById('mixBtn');
const mixDurationValue = document.getElementById('mixDurationValue');
const muteBtn = document.getElementById('muteBtn');
const volIcon = document.getElementById('volIcon');
const volumeSlider = document.getElementById('volumeSlider');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const progressFillIncoming = document.getElementById('progressFillIncoming');
const sliderWrapper = document.getElementById('sliderWrapper');
const incomingLane = document.getElementById('incomingLane');
const mixThumbs = document.getElementById('mixThumbs');
const mixThumbOut = document.getElementById('mixThumbOut');
const mixThumbIn = document.getElementById('mixThumbIn');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const currentTitle = document.getElementById('currentTitle');
const nextTitle = document.getElementById('nextTitle');
const nowPlayingArt = document.getElementById('nowPlayingArt');
const nowPlayingListBtn = document.getElementById('nowPlayingListBtn');
const nowPlayingListIcon = document.getElementById('nowPlayingListIcon');
const nowPlayingDownloadBtn = document.getElementById('nowPlayingDownloadBtn');
const playlistEl = document.getElementById('playlist');
const coverArtCache = new Map(); // file url -> objectURL | null
const disc = document.getElementById('disc');
const eqBars = document.getElementById('eqBars');
const tabAll = document.getElementById('tabAll');
const tabMyList = document.getElementById('tabMyList');

// State
let currentIndex = 0; // index in full `tracks` array
let isPlaying = false;
let isSeeking = false;
let seekFallbackTimer = null;
let pendingSeekTime = null;
let autoMixPrepareTimer = null;
const SILENCE_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAIDRhYWR0AgAAAAEA';
const IDLE_TITLE = 'Druk play';

function masterVolume() {
  return Number(volumeSlider.value);
}

function finishSeek() {
  audio.removeEventListener('seeked', finishSeek);
  clearTimeout(seekFallbackTimer);
  seekFallbackTimer = null;
  pendingSeekTime = null;
  isSeeking = false;
  updateProgress();
}

function getBufferedEnd() {
  try {
    if (!audio.buffered || !audio.buffered.length) return 0;
    return audio.buffered.end(audio.buffered.length - 1);
  } catch {
    return 0;
  }
}

function getMaxSeekableTime() {
  try {
    if (!audio.seekable || !audio.seekable.length) return 0;
    return audio.seekable.end(audio.seekable.length - 1);
  } catch {
    return 0;
  }
}

function mediaCanSeek() {
  try {
    return Boolean(
      audio.duration
      && Number.isFinite(audio.duration)
      && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && getBufferedEnd() > 0
    );
  } catch {
    return false;
  }
}

function timeIsSeekable(time) {
  // Use buffered ranges — plain python http.server lies via seekable (no HTTP Range),
  // so seeking outside the downloaded buffer snaps back to 0.
  try {
    if (!audio.buffered || !audio.buffered.length) return false;
    for (let i = 0; i < audio.buffered.length; i++) {
      if (time >= audio.buffered.start(i) && time <= audio.buffered.end(i) - 0.05) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function clearSeekRetryListeners(retry) {
  if (!retry) return;
  audio.removeEventListener('progress', retry);
  audio.removeEventListener('canplay', retry);
  audio.removeEventListener('canplaythrough', retry);
}

function applySeek(time) {
  audio.removeEventListener('seeked', finishSeek);
  audio.addEventListener('seeked', finishSeek);
  clearTimeout(seekFallbackTimer);
  seekFallbackTimer = setTimeout(finishSeek, 500);
  try {
    audio.currentTime = time;
    // If the browser rejected the seek (common without HTTP Range), retry later.
    requestAnimationFrame(() => {
      if (Math.abs(audio.currentTime - time) > 1.25) {
        pendingSeekTime = time;
        const retry = () => {
          if (pendingSeekTime == null) return;
          if (timeIsSeekable(pendingSeekTime)) {
            const t = pendingSeekTime;
            pendingSeekTime = null;
            clearSeekRetryListeners(retry);
            applySeek(t);
          }
        };
        audio.addEventListener('progress', retry);
        clearTimeout(seekFallbackTimer);
        seekFallbackTimer = setTimeout(() => {
          clearSeekRetryListeners(retry);
          pendingSeekTime = null;
          finishSeek();
        }, 20000);
      }
    });
  } catch (err) {
    console.error('Seek failed:', err);
    finishSeek();
  }
}

/** True when the player has enough media buffered that analysis downloads are safer. */
function mediaHasHealthyBuffer() {
  if (!audio.duration || !Number.isFinite(audio.duration)) return false;
  const end = getBufferedEnd();
  return end - audio.currentTime >= 15 || end >= audio.duration - 0.5;
}

function clearDeck(el) {
  el.pause();
  el.removeAttribute('src');
  el.load();
}

function cancelMix() {
  isMixing = false;
  pendingMixIndex = -1;
  plannedNextIndex = -1;
  mixBlendT = 0;
  mixStartOutPercent = 0;
  mixAudioT0 = 0;
  mixDurationSec = 0;
  clearDeck(audioIncoming);
  if (!audio.muted) {
    audio.volume = masterVolume();
  }
  setMixProgressUi(false);
}

function planNextIndex() {
  const visible = getVisibleTracks();
  // Drop a stale pick from when only 1 track existed (common right after Lap_1 bootstrap).
  if (
    plannedNextIndex >= 0
    && plannedNextIndex < tracks.length
    && !(plannedNextIndex === currentIndex && visible.length > 1)
  ) {
    return plannedNextIndex;
  }
  plannedNextIndex = resolveNextIndex();
  return plannedNextIndex;
}

function updateNextTitle() {
  if (!nextTitle) return;
  if (!tracks.length || !deckHasTrackSrc()) {
    nextTitle.textContent = '';
    nextTitle.hidden = true;
    return;
  }

  const nextIndex = planNextIndex();
  if (nextIndex < 0 || !tracks[nextIndex]) {
    nextTitle.textContent = '';
    nextTitle.hidden = true;
    return;
  }

  // Only hide when there is genuinely no other track yet.
  if (nextIndex === currentIndex) {
    nextTitle.textContent = '';
    nextTitle.hidden = true;
    return;
  }

  nextTitle.textContent = tracks[nextIndex].title;
  nextTitle.hidden = false;
}

function readSynchsafeSize(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f)
  );
}

function findNull(bytes, start, encoding) {
  if (encoding === 0 || encoding === 3) {
    for (let i = start; i < bytes.length; i++) {
      if (bytes[i] === 0) return i;
    }
    return -1;
  }
  // UTF-16: double null
  for (let i = start; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
  }
  return -1;
}

function extractCoverFromId3(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return null;
  }
  const ver = bytes[3];
  const tagSize = readSynchsafeSize(bytes, 6);
  let pos = 10;
  const end = Math.min(bytes.length, 10 + tagSize);

  while (pos + 10 <= end) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    if (id === '\0\0\0\0') break;

    let frameSize;
    if (ver >= 4) {
      frameSize = readSynchsafeSize(bytes, pos + 4);
    } else {
      frameSize = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];
    }
    if (frameSize <= 0 || pos + 10 + frameSize > bytes.length) break;

    if (id === 'APIC') {
      const frame = bytes.subarray(pos + 10, pos + 10 + frameSize);
      const encoding = frame[0];
      let i = 1;
      // MIME (always ISO-8859-1, null-terminated)
      const mimeEnd = findNull(frame, i, 0);
      if (mimeEnd < 0) return null;
      let mime = String.fromCharCode(...frame.subarray(i, mimeEnd)) || 'image/jpeg';
      if (mime === 'JPG' || mime === 'image/jpg') mime = 'image/jpeg';
      i = mimeEnd + 1;
      i += 1; // picture type
      const descEnd = findNull(frame, i, encoding);
      if (descEnd < 0) return null;
      i = descEnd + ((encoding === 0 || encoding === 3) ? 1 : 2);
      const imageBytes = frame.subarray(i);
      if (!imageBytes.length) return null;
      return new Blob([imageBytes], { type: mime });
    }

    pos += 10 + frameSize;
  }
  return null;
}

async function loadCoverArtUrl(fileUrl) {
  if (coverArtCache.has(fileUrl)) {
    return coverArtCache.get(fileUrl);
  }

  try {
    let bytes;
    const ranged = await fetch(fileUrl, {
      headers: { Range: 'bytes=0-524287' },
      cache: 'force-cache',
    });
    if (ranged.ok || ranged.status === 206) {
      bytes = new Uint8Array(await ranged.arrayBuffer());
    } else {
      const full = await fetch(fileUrl, { cache: 'force-cache' });
      if (!full.ok) throw new Error('cover fetch failed');
      const buf = await full.arrayBuffer();
      bytes = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 524288)));
    }

    const blob = extractCoverFromId3(bytes);
    if (!blob) {
      coverArtCache.set(fileUrl, null);
      return null;
    }
    const objectUrl = URL.createObjectURL(blob);
    coverArtCache.set(fileUrl, objectUrl);
    return objectUrl;
  } catch (err) {
    console.error('Cover art load failed:', err);
    coverArtCache.set(fileUrl, null);
    return null;
  }
}

async function updateNowPlayingArt(track) {
  if (!nowPlayingArt) return;
  if (!track) {
    nowPlayingArt.style.backgroundImage = '';
    nowPlayingArt.classList.remove('has-art');
    return;
  }

  const url = await loadCoverArtUrl(track.file);
  // Ignore stale responses after a quick track change
  if (tracks[currentIndex]?.file !== track.file) return;

  if (url) {
    nowPlayingArt.style.backgroundImage = `url("${url}")`;
    nowPlayingArt.classList.add('has-art');
  } else {
    nowPlayingArt.style.backgroundImage = '';
    nowPlayingArt.classList.remove('has-art');
  }
}

function loadMyList() {
  try {
    const raw = localStorage.getItem(MY_LIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function saveMyList() {
  localStorage.setItem(MY_LIST_KEY, JSON.stringify(myListNames));
}

function trackKey(name) {
  return String(name || '').toLowerCase();
}

function isInMyList(name) {
  const key = trackKey(name);
  return myListNames.some((n) => trackKey(n) === key);
}

function updateNowPlayingListBtn() {
  if (!nowPlayingListBtn || !nowPlayingListIcon) return;
  const track = tracks[currentIndex];
  if (!track || !deckHasTrackSrc()) {
    nowPlayingListBtn.hidden = true;
    updateNowPlayingDownloadBtn();
    return;
  }

  const inList = isInMyList(track.title);
  nowPlayingListBtn.hidden = false;
  nowPlayingListBtn.classList.toggle('in-list', inList);
  nowPlayingListBtn.title = inList ? 'Uit My list' : 'Naar My list';
  nowPlayingListBtn.setAttribute('aria-label', inList ? 'Uit My list' : 'Naar My list');
  nowPlayingListIcon.className = `fa-solid ${inList ? 'fa-minus' : 'fa-plus'}`;
  updateNowPlayingDownloadBtn();
}

function trackDownloadName(track) {
  const fromFile = String(track?.file || '').split('/').pop();
  if (fromFile && /\.mp3$/i.test(fromFile)) return fromFile;
  const title = String(track?.title || 'track').replace(/[^\w.-]+/g, '_');
  return `${title}.mp3`;
}

function updateNowPlayingDownloadBtn() {
  if (!nowPlayingDownloadBtn) return;
  const track = tracks[currentIndex];
  if (!track || !deckHasTrackSrc()) {
    nowPlayingDownloadBtn.hidden = true;
    nowPlayingDownloadBtn.removeAttribute('href');
    nowPlayingDownloadBtn.removeAttribute('download');
    return;
  }

  const name = trackDownloadName(track);
  nowPlayingDownloadBtn.hidden = false;
  nowPlayingDownloadBtn.href = track.file;
  nowPlayingDownloadBtn.setAttribute('download', name);
  nowPlayingDownloadBtn.title = `Download ${track.title}`;
  nowPlayingDownloadBtn.setAttribute('aria-label', `Download ${track.title}`);
}

async function downloadCurrentTrack(event) {
  if (event) event.preventDefault();
  const track = tracks[currentIndex];
  if (!track || !deckHasTrackSrc()) return;

  const name = trackDownloadName(track);
  try {
    const res = await fetch(track.file, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    console.error('Download failed:', err);
    // Last resort: open the file URL (may play in a tab on some hosts).
    window.open(track.file, '_blank', 'noopener');
  }
}

function toggleMyList(name) {
  const key = trackKey(name);
  if (isInMyList(name)) {
    myListNames = myListNames.filter((n) => trackKey(n) !== key);
  } else {
    myListNames.push(name);
  }
  saveMyList();
  plannedNextIndex = -1;
  renderPlaylist();
  updateNextTitle();
  updateNowPlayingListBtn();
}

async function loadTracksManifest() {
  const res = await fetch('tracks.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`tracks.json HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.tracks) || !data.tracks.length) {
    throw new Error('tracks.json missing tracks[]');
  }
  tracks = data.tracks.map((t) => ({
    id: Number(t.id),
    title: String(t.title || `${TRACK_PREFIX}${t.id}`),
    file: String(t.file || `${TRACK_DIR}/${TRACK_PREFIX}${t.id}.mp3`),
    introSec: Number(t.introSec),
    outroSec: Number(t.outroSec),
  })).sort((a, b) => a.id - b.id);
}

function updateTrackCountStatus() {
  const trackCountEl = document.getElementById('trackCount');
  if (!trackCountEl) return;
  trackCountEl.textContent = `${getVisibleTracks().length}`;
}

function reconcileMyList() {
  const byKey = new Map(tracks.map((t) => [trackKey(t.title), t.title]));
  myListNames = [...new Set(
    myListNames
      .map((name) => byKey.get(trackKey(name)))
      .filter(Boolean)
  )];
  saveMyList();
}

function getVisibleTracks() {
  if (activeTab === 'mylist') {
    // Keep My list order from localStorage (drag-reorder)
    return myListNames
      .map((name) => tracks.find((t) => trackKey(t.title) === trackKey(name)))
      .filter(Boolean);
  }
  return tracks;
}

function reorderMyList(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= myListNames.length || toIndex >= myListNames.length) return;
  const [moved] = myListNames.splice(fromIndex, 1);
  myListNames.splice(toIndex, 0, moved);
  saveMyList();
  plannedNextIndex = -1;
  autoMixSec = null;
  autoMixKey = null;
  clearIncomingIfIdle();
  renderPlaylist();
  updateNextTitle();
  if (mixOn) {
    scheduleAutoMixPrepare();
  }
}

function indexInVisible(visible, globalIndex) {
  return visible.findIndex((t) => tracks.indexOf(t) === globalIndex || t.id === tracks[globalIndex]?.id);
}

async function initPlayer() {
  audio.playbackRate = 1;
  audio.volume = masterVolume();
  audioIncoming.volume = masterVolume();

  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', playPrevious);
  nextBtn.addEventListener('click', playNext);
  randomBtn.addEventListener('click', toggleShuffle);
  mixBtn.addEventListener('click', toggleMix);
  muteBtn.addEventListener('click', toggleMute);
  tabAll.addEventListener('click', () => setTab('all'));
  tabMyList.addEventListener('click', () => setTab('mylist'));
  nowPlayingListBtn?.addEventListener('click', () => {
    const track = tracks[currentIndex];
    if (track) toggleMyList(track.title);
  });
  nowPlayingDownloadBtn?.addEventListener('click', downloadCurrentTrack);

  [audioA, audioB].forEach((el) => {
    el.addEventListener('timeupdate', onAudioTimeUpdate);
    el.addEventListener('loadedmetadata', handleMetadataLoaded);
    el.addEventListener('ended', onTrackEnded);
  });

  progressBar.addEventListener('input', onScrubberInput);
  progressBar.addEventListener('change', onScrubberChange);

  volumeSlider.addEventListener('input', (e) => {
    const vol = Number(e.target.value);
    if (!isMixing) {
      audio.volume = vol;
    }
    updateVolumeIcon(vol);
  });

  updateMixDurationUi();
  window.addEventListener('resize', () => {
    if (!isSeeking) updateProgress();
  });
  document.addEventListener('visibilitychange', onVisibilityChange);

  currentTitle.textContent = IDLE_TITLE;
  updateNowPlayingListBtn();
  renderPlaylist();

  try {
    await loadTracksManifest();
  } catch (err) {
    console.error('Failed to load tracks.json:', err);
    tracks = [];
    currentIndex = 0;
    currentTitle.textContent = 'Geen tracks gevonden';
    updateNowPlayingListBtn();
    playlistEl.innerHTML = '<p class="playlist-empty">tracks.json ontbreekt of is ongeldig.</p>';
    const trackCountEl = document.getElementById('trackCount');
    if (trackCountEl) trackCountEl.textContent = '0';
    return;
  }

  reconcileMyList();
  renderPlaylist();
  updateNextTitle();
  updateTrackCountStatus();
}

function setTab(tab) {
  activeTab = tab;
  tabAll.classList.toggle('active', tab === 'all');
  tabMyList.classList.toggle('active', tab === 'mylist');
  tabAll.setAttribute('aria-selected', tab === 'all' ? 'true' : 'false');
  tabMyList.setAttribute('aria-selected', tab === 'mylist' ? 'true' : 'false');
  plannedNextIndex = -1;
  autoMixSec = null;
  autoMixKey = null;
  autoMixPreparing = null;
  clearIncomingIfIdle();
  renderPlaylist();
  updateNextTitle();
  if (mixOn) {
    scheduleAutoMixPrepare();
  }
  // After a short My list shrinks the page, clamp scroll so iOS doesn't bounce/flicker.
  requestAnimationFrame(() => {
    const doc = document.documentElement;
    const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
    if (window.scrollY > maxScroll) {
      window.scrollTo(0, maxScroll);
    }
  });
}

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  randomBtn.classList.toggle('active', shuffleOn);
  randomBtn.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
  // Mode only — next random pick happens on track end / next / Mix, not on toggle.
  plannedNextIndex = -1;
  autoMixSec = null;
  autoMixKey = null;
  autoMixPreparing = null;
  clearIncomingIfIdle();
  updateNextTitle();
  if (mixOn) {
    scheduleAutoMixPrepare();
  }
}

function toggleMix() {
  mixOn = !mixOn;
  mixBtn.classList.toggle('active', mixOn);
  mixBtn.setAttribute('aria-pressed', mixOn ? 'true' : 'false');
  if (!mixOn) {
    cancelMix();
  } else {
    autoMixSec = null;
    autoMixKey = null;
    scheduleAutoMixPrepare();
  }
  updateMixDurationUi();
}

function formatMixSec(sec) {
  return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
}

function updateMixDurationUi() {
  if (!mixDurationValue) return;
  if (!mixOn) {
    mixDurationValue.textContent = '';
    return;
  }
  if (isAutoMixReady()) {
    mixDurationValue.textContent = formatMixSec(autoMixSec);
  } else {
    mixDurationValue.textContent = '…';
  }
}

function clampMixSec(sec) {
  return Math.min(MIX_MAX_SEC, Math.max(MIX_MIN_SEC, sec));
}

function clampAutoMixSec(sec) {
  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, sec));
}

function currentAutoMixKey() {
  if (!tracks.length) return null;
  const nextIndex = planNextIndex();
  if (nextIndex < 0) return null;
  return `${currentIndex}>${nextIndex}`;
}

function isAutoMixReady() {
  if (!mixOn || autoMixSec == null || autoMixPreparing) return false;
  const key = currentAutoMixKey();
  return key != null && autoMixKey === key;
}

function computeAutoMixSecFromTracks(current, next, trackDuration) {
  const outro = Number(current?.outroSec);
  const intro = Number(next?.introSec);
  if (!Number.isFinite(outro) || !Number.isFinite(intro)) {
    return MIX_DEFAULT_SEC;
  }
  let sec = outro * 0.55 + intro * 0.45;
  sec = clampAutoMixSec(sec);
  if (trackDuration && Number.isFinite(trackDuration) && trackDuration > 0) {
    sec = Math.min(sec, Math.max(AUTO_MIX_MIN_SEC, trackDuration * 0.4));
  }
  return Math.round(sec * 10) / 10;
}

function incomingAlreadyHas(file) {
  const src = audioIncoming.currentSrc || audioIncoming.getAttribute('src') || '';
  if (!src || src.startsWith('data:')) return false;
  return src.includes(file) || src.endsWith(file);
}

function ensureNextBuffered() {
  if (!tracks.length || isMixing) return;
  if (!isPlaying || !deckHasTrackSrc()) return;
  if (!mediaHasHealthyBuffer()) return;
  const nextIndex = planNextIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;
  const next = tracks[nextIndex];
  if (!next) return;
  if (incomingAlreadyHas(next.file)) return;

  audioIncoming.src = next.file;
  audioIncoming.playbackRate = 1;
  audioIncoming.volume = 0;
  // Do not play until startMix / explicit navigation
}

function clearIncomingIfIdle() {
  if (isMixing) return;
  clearDeck(audioIncoming);
}

function scheduleAutoMixPrepare() {
  if (!mixOn || !tracks.length) return;
  clearTimeout(autoMixPrepareTimer);

  const tryPrepare = () => {
    if (!mixOn) return;
    if (isPlaying && !mediaCanSeek()) {
      autoMixPrepareTimer = setTimeout(tryPrepare, 400);
      return;
    }
    prepareAutoMix();
  };

  autoMixPrepareTimer = setTimeout(tryPrepare, mediaCanSeek() ? 200 : 800);
}

function prepareAutoMix() {
  if (!mixOn || !tracks.length) return;

  const nextIndex = planNextIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;

  const key = `${currentIndex}>${nextIndex}`;
  if (autoMixKey === key && autoMixSec != null) {
    ensureNextBuffered();
    return;
  }

  const current = tracks[currentIndex];
  const next = tracks[nextIndex];
  if (!current || !next) return;

  autoMixPreparing = null;
  autoMixSec = computeAutoMixSecFromTracks(current, next, audio.duration);
  autoMixKey = key;
  updateMixDurationUi();
  ensureNextBuffered();
  maybeStartMix();
}

function resolveNextIndex() {
  const visible = getVisibleTracks();
  if (!visible.length) return -1;

  if (shuffleOn) {
    let pick = visible[Math.floor(Math.random() * visible.length)];
    if (visible.length > 1) {
      let guard = 0;
      while (tracks.indexOf(pick) === currentIndex && guard < 10) {
        pick = visible[Math.floor(Math.random() * visible.length)];
        guard += 1;
      }
    }
    return tracks.indexOf(pick);
  }

  const pos = indexInVisible(visible, currentIndex);
  const nextPos = pos >= 0 ? (pos + 1) % visible.length : 0;
  return tracks.indexOf(visible[nextPos]);
}

function effectiveMixSeconds(duration, preferredSec) {
  if (!duration || !Number.isFinite(duration)) return 0;
  if (preferredSec == null) return 0;
  const capped = Math.min(preferredSec, duration * 0.4);
  if (capped < 1.5) return 0;
  return capped;
}

function onAudioTimeUpdate(e) {
  // During mix, both decks may emit timeupdate — tick from either.
  if (isMixing) {
    if (e.target === audio || e.target === audioIncoming) {
      tickMix();
    }
    return;
  }
  if (e.target !== audio) return;

  updateProgress();
  if (isPlaying && mediaHasHealthyBuffer()) {
    ensureNextBuffered();
  }
  if (mixOn && audio.duration) {
    const remaining = audio.duration - audio.currentTime;
    if (remaining <= 60) {
      if (remaining <= 20 && mediaCanSeek()) {
        prepareAutoMix();
      } else {
        scheduleAutoMixPrepare();
      }
    }
  }
  maybeStartMix();
}

function maybeStartMix() {
  if (!mixOn || isMixing || isSeeking || !isPlaying) return;
  if (!audio.duration || !Number.isFinite(audio.duration)) return;

  if (!isAutoMixReady()) {
    scheduleAutoMixPrepare();
    return;
  }
  const preferred = autoMixSec;

  const remaining = audio.duration - audio.currentTime;
  const mixSec = effectiveMixSeconds(audio.duration, preferred);
  if (!mixSec) return;
  if (remaining > mixSec) return;

  // If analysis finished late, fade over the time that is actually left.
  const liveSec = Math.min(mixSec, remaining - 0.05);
  if (liveSec < 1.5) return;
  startMix(liveSec);
}

function tickMix() {
  if (!isMixing || pendingMixIndex < 0) return;
  if (!mixDurationSec || mixDurationSec <= 0) {
    finishMix(pendingMixIndex);
    return;
  }

  const elapsed = Math.max(0, audio.currentTime - mixAudioT0);
  const rawT = Math.min(1, elapsed / mixDurationSec);
  const t = easeMix(rawT);
  mixBlendT = t;
  const m = masterVolume();
  if (!audio.muted) {
    audio.volume = m * (1 - t);
    audioIncoming.volume = m * t;
  }
  updateProgress();

  if (rawT >= 1) {
    finishMix(pendingMixIndex);
  }
}

function startMix(mixSec) {
  const nextIndex = planNextIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;

  isMixing = true;
  pendingMixIndex = nextIndex;
  const nextTrack = tracks[nextIndex];

  // Prefer already-buffered next; only set src if needed.
  if (!incomingAlreadyHas(nextTrack.file)) {
    audioIncoming.src = nextTrack.file;
  }
  audioIncoming.playbackRate = 1;
  audioIncoming.muted = audio.muted;
  audioIncoming.volume = 0;

  audioIncoming.play().then(() => {
    if (!isMixing || pendingMixIndex !== nextIndex) return;
    mixAudioT0 = audio.currentTime;
    mixDurationSec = mixSec;
    mixStartOutPercent = audio.duration
      ? (audio.currentTime / audio.duration) * 100
      : 0;
    mixBlendT = 0;
    setMixProgressUi(true);
    tickMix();
  }).catch((err) => {
    console.error('Mix start failed:', err);
    cancelMix();
  });
}

function finishMix(nextIndex) {
  const outgoing = audio;
  outgoing.pause();
  clearDeck(outgoing);

  audio = audioIncoming;
  audioIncoming = outgoing;

  if (!audio.muted) {
    audio.volume = masterVolume();
  }

  currentIndex = nextIndex;
  currentTitle.textContent = tracks[currentIndex].title;
  updateNowPlayingArt(tracks[currentIndex]);
  updateNowPlayingListBtn();
  pendingMixIndex = -1;
  isMixing = false;
  isPlaying = true;
  playIcon.className = 'fa-solid fa-pause';
  disc.classList.add('spinning');
  eqBars.classList.add('playing');

  autoMixSec = null;
  autoMixKey = null;
  autoMixPreparing = null;
  plannedNextIndex = -1;
  mixBlendT = 0;
  mixStartOutPercent = 0;
  mixAudioT0 = 0;
  mixDurationSec = 0;

  const handoffPercent = audio.duration
    ? (audio.currentTime / audio.duration) * 100
    : 0;
  setMixProgressUi(false);
  setRangeAndFill(handoffPercent);
  if (progressFill) progressFill.style.opacity = '1';
  if (progressFillIncoming) {
    progressFillIncoming.style.opacity = '1';
    progressFillIncoming.style.width = '0%';
  }

  updateProgress();
  if (audio.duration) {
    durationEl.textContent = formatTime(audio.duration);
  }
  renderPlaylist();
  updateNextTitle();
  if (mixOn) {
    scheduleAutoMixPrepare();
  }
  updateMixDurationUi();
}

function onVisibilityChange() {
  // Screen lock / background: snap any in-progress mix so the incoming
  // track becomes the active deck (audio keeps playing without rAF).
  if (document.visibilityState !== 'hidden') return;
  if (isMixing && pendingMixIndex >= 0) {
    finishMix(pendingMixIndex);
  }
}

function renderPlaylist() {
  const visible = getVisibleTracks();
  updateTrackCountStatus();

  playlistEl.innerHTML = '';
  // Clip+scroll from 3+ rows; shorter lists stay in page flow (avoids mobile flicker).
  playlistEl.classList.toggle('is-clipped', visible.length >= 3);

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'playlist-empty';
    empty.textContent = activeTab === 'mylist'
      ? 'My list is leeg. Voeg nummers toe via + in All.'
      : 'Geen tracks.';
    playlistEl.appendChild(empty);
    return;
  }

  let suppressClick = false;

  visible.forEach((track, index) => {
    const globalIndex = tracks.indexOf(track);
    const inList = isInMyList(track.title);
    const item = document.createElement('div');
    item.className = [
      'track-item',
      globalIndex === currentIndex ? 'active' : '',
      activeTab === 'all' && inList ? 'in-my-list' : '',
    ].filter(Boolean).join(' ');
    item.dataset.index = String(index);

    item.innerHTML = `
      <div class="track-num">${String(index + 1).padStart(2, '0')}</div>
      <div class="track-details">
        <div class="track-name">${track.title}</div>
      </div>
      <button type="button" class="list-toggle-btn ${inList ? 'in-list' : ''}" title="${inList ? 'Uit My list' : 'Naar My list'}" aria-label="${inList ? 'Uit My list' : 'Naar My list'}">
        <i class="fa-solid ${inList ? 'fa-minus' : 'fa-plus'}"></i>
      </button>
      <div class="track-play-icon">
        <i class="fa-solid ${globalIndex === currentIndex && isPlaying ? 'fa-chart-simple' : 'fa-circle-play'}"></i>
      </div>
    `;

    const toggleBtn = item.querySelector('.list-toggle-btn');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMyList(track.title);
    });

    // Native HTML5 drag fights touch scrolling on phones (flicker at page bottom).
    // Keep reorder on fine pointers only (mouse / trackpad).
    const canDragReorder =
      activeTab === 'mylist'
      && window.matchMedia('(pointer: fine)').matches;

    if (canDragReorder) {
      item.draggable = true;
      item.classList.add('draggable');
      item.title = 'Sleep om volgorde te wijzigen';

      item.addEventListener('dragstart', (e) => {
        if (e.target.closest('.list-toggle-btn')) {
          e.preventDefault();
          return;
        }
        suppressClick = false;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        playlistEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const fromIndex = Number(e.dataTransfer.getData('text/plain'));
        const toIndex = index;
        if (Number.isNaN(fromIndex) || fromIndex === toIndex) return;
        suppressClick = true;
        reorderMyList(fromIndex, toIndex);
      });
    }

    item.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      selectTrack(globalIndex);
    });

    playlistEl.appendChild(item);
  });
}

function loadTrack(index, shouldPlay = true) {
  if (!tracks.length || index < 0 || index >= tracks.length) return;

  cancelMix();
  clearTimeout(autoMixPrepareTimer);
  pendingSeekTime = null;

  currentIndex = index;
  autoMixSec = null;
  autoMixKey = null;
  autoMixPreparing = null;
  plannedNextIndex = -1;

  const track = tracks[currentIndex];
  // Setting src starts loading; do not call load() again (aborts/restarts and
  // breaks first-track seeking on servers without Range support).
  audio.src = track.file;
  audio.playbackRate = 1;
  if (!audio.muted) {
    audio.volume = masterVolume();
  }
  currentTitle.textContent = track.title;
  updateNowPlayingArt(track);
  updateNowPlayingListBtn();

  setRangeAndFill(0);
  if (progressFillIncoming) progressFillIncoming.style.width = '0%';
  if (progressFill) progressFill.style.opacity = '1';
  setMixProgressUi(false);
  currentTimeEl.textContent = '00:00:00';
  durationEl.textContent = '--:--:--';

  renderPlaylist();
  updateNextTitle();
  updateMixDurationUi();

  if (shouldPlay) {
    playTrack();
  }
  // Auto analysis is scheduled from playTrack once media can seek —
  // starting it here starved the scrubber on cold refresh.
}

function togglePlay() {
  if (isPlaying) {
    pauseTrack();
  } else {
    playTrack();
  }
}

let decksUnlocked = false;

function unlockAudioDecks() {
  if (decksUnlocked) return;
  decksUnlocked = true;
  // Prime with silence — do NOT re-download the current track (that blocked seeking).
  const el = audioIncoming;
  el.src = SILENCE_WAV;
  el.volume = 0;
  el.muted = true;
  el.play().then(() => {
    el.pause();
    clearDeck(el);
    el.muted = audio.muted;
  }).catch(() => {
    clearDeck(el);
    el.muted = audio.muted;
    decksUnlocked = false;
  });
}

function pickStartIndex() {
  const visible = getVisibleTracks();
  if (!visible.length) return -1;
  if (shuffleOn) {
    const pick = visible[Math.floor(Math.random() * visible.length)];
    return tracks.indexOf(pick);
  }
  return tracks.indexOf(visible[0]);
}

function deckHasTrackSrc() {
  const src = audio.currentSrc || audio.getAttribute('src') || '';
  return Boolean(src) && !src.startsWith('data:');
}

function playTrack() {
  if (!tracks.length) return;
  if (!deckHasTrackSrc()) {
    const idx = pickStartIndex();
    if (idx < 0) return;
    loadTrack(idx, true);
    return;
  }
  audio.play().then(() => {
    unlockAudioDecks();
    isPlaying = true;
    playIcon.className = 'fa-solid fa-pause';
    disc.classList.add('spinning');
    eqBars.classList.add('playing');
    renderPlaylist();
    if (mixOn) {
      scheduleAutoMixPrepare();
    }
  }).catch((err) => {
    console.error('Playback error:', err);
  });
}

function pauseTrack() {
  if (isMixing) {
    cancelMix();
  }
  audio.pause();
  isPlaying = false;
  playIcon.className = 'fa-solid fa-play';
  disc.classList.remove('spinning');
  eqBars.classList.remove('playing');
  renderPlaylist();
}

function onTrackEnded(e) {
  if (e && e.target !== audio) return;

  if (isMixing && pendingMixIndex >= 0) {
    finishMix(pendingMixIndex);
    return;
  }

  // Keep the playback chain alive (important when the screen is locked).
  if (shuffleOn) {
    playRandom();
  } else {
    playNext();
  }
}

function playRandom() {
  const nextIndex = resolveNextIndex();
  if (nextIndex < 0) return;
  loadTrack(nextIndex, true);
}

function playNext() {
  if (!deckHasTrackSrc()) {
    playTrack();
    return;
  }
  cancelMix();
  const nextIndex = resolveNextIndex();
  if (nextIndex < 0) return;
  loadTrack(nextIndex, true);
}

function playPrevious() {
  if (!deckHasTrackSrc()) {
    playTrack();
    return;
  }
  cancelMix();
  const visible = getVisibleTracks();
  if (!visible.length) return;

  if (shuffleOn) {
    playRandom();
    return;
  }

  const pos = indexInVisible(visible, currentIndex);
  const prevPos = pos >= 0
    ? (pos - 1 + visible.length) % visible.length
    : 0;
  loadTrack(tracks.indexOf(visible[prevPos]), true);
}

function selectTrack(index) {
  if (currentIndex === index && isPlaying) {
    pauseTrack();
  } else {
    loadTrack(index, true);
  }
}

function handleMetadataLoaded(e) {
  if (e && e.target !== audio) return;
  durationEl.textContent = formatTime(audio.duration);
}

function setMixProgressUi(on) {
  if (sliderWrapper) {
    sliderWrapper.classList.toggle('is-mixing', on);
  }
  if (incomingLane) {
    incomingLane.hidden = !on;
  }
  if (mixThumbs) {
    mixThumbs.hidden = !on;
  }
  if (progressBar) {
    progressBar.disabled = on;
    progressBar.setAttribute('aria-disabled', on ? 'true' : 'false');
  }
  if (!on) {
    if (progressFillIncoming) {
      progressFillIncoming.style.width = '0%';
    }
    if (mixThumbOut) mixThumbOut.style.left = '0%';
    if (mixThumbIn) mixThumbIn.style.left = '0%';
  }
}

function scrubThumbPx() {
  if (!sliderWrapper) return 40;
  const v = Number.parseFloat(getComputedStyle(sliderWrapper).getPropertyValue('--scrub-thumb'));
  return Number.isFinite(v) && v > 0 ? v : 40;
}

/**
 * Native <input type="range"> moves the thumb along (trackWidth - thumbWidth),
 * not the full track. Fill width must use the same mapping or the tip and
 * ball drift apart (especially visible at the start).
 */
function fillWidthFromRangeValue(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const trackW = progressBar?.getBoundingClientRect().width || 0;
  const thumb = scrubThumbPx();
  if (trackW <= thumb) return v;
  const centerX = thumb / 2 + (v / 100) * (trackW - thumb);
  return (centerX / trackW) * 100;
}

function setThumbLeft(el, valuePercent) {
  if (!el) return;
  el.style.left = `${fillWidthFromRangeValue(valuePercent)}%`;
}

function setRangeAndFill(valuePercent, fillEl = progressFill) {
  const v = Math.max(0, Math.min(100, Number(valuePercent) || 0));
  if (fillEl === progressFill) {
    progressBar.value = v;
  }
  if (fillEl) {
    fillEl.style.width = `${fillWidthFromRangeValue(v)}%`;
  }
}

function trackPercent(el) {
  if (!el || !el.duration || !Number.isFinite(el.duration) || el.duration <= 0) {
    return 0;
  }
  return (el.currentTime / el.duration) * 100;
}

function updateProgress() {
  if (isSeeking) return;

  if (isMixing) {
    setMixProgressUi(true);
    const outP = trackPercent(audio);
    const inP = trackPercent(audioIncoming);

    if (progressFill) {
      progressFill.style.width = `${fillWidthFromRangeValue(outP)}%`;
      progressFill.style.opacity = '1';
    }
    if (progressFillIncoming) {
      progressFillIncoming.style.width = `${fillWidthFromRangeValue(inP)}%`;
      progressFillIncoming.style.opacity = '1';
    }
    setThumbLeft(mixThumbOut, outP);
    setThumbLeft(mixThumbIn, inP);
    // Keep range value on outgoing for when mix ends (no visual thumb).
    progressBar.value = outP;
    if (audio.duration) {
      currentTimeEl.textContent = formatTime(audio.currentTime);
    }
    return;
  }

  if (audio.duration) {
    const percent = (audio.currentTime / audio.duration) * 100;
    setRangeAndFill(percent);
    if (progressFill) progressFill.style.opacity = '1';
    currentTimeEl.textContent = formatTime(audio.currentTime);
  }
  if (progressFillIncoming) {
    progressFillIncoming.style.width = '0%';
  }
}

function onScrubberInput(e) {
  if (isMixing) return;
  isSeeking = true;
  const percent = e.target.value;
  if (progressFill) {
    progressFill.style.width = `${fillWidthFromRangeValue(percent)}%`;
  }
  if (audio.duration) {
    currentTimeEl.textContent = formatTime((percent / 100) * audio.duration);
  }
}

function seekToPercent(percent) {
  if (isMixing) return;
  if (!audio.duration || Number.isNaN(audio.duration)) {
    isSeeking = false;
    return;
  }

  const value = Number(percent);
  const time = Math.min(audio.duration, Math.max(0, (value / 100) * audio.duration));
  isSeeking = true;
  setRangeAndFill(value);
  currentTimeEl.textContent = formatTime(time);

  // Target already buffered/seekable → seek immediately.
  if (timeIsSeekable(time)) {
    pendingSeekTime = null;
    applySeek(time);
    return;
  }

  // NOT seekable yet — wait for buffer. Never force a seek into an unbuffered
  // range (that snapped LAP_1 back to 0 on cold start).
  pendingSeekTime = time;
  const retry = () => {
    if (pendingSeekTime == null) return;
    if (timeIsSeekable(pendingSeekTime)) {
      const t = pendingSeekTime;
      pendingSeekTime = null;
      clearSeekRetryListeners(retry);
      clearTimeout(seekFallbackTimer);
      applySeek(t);
    }
  };
  clearSeekRetryListeners(retry);
  audio.addEventListener('progress', retry);
  audio.addEventListener('canplay', retry);
  audio.addEventListener('canplaythrough', retry);
  clearTimeout(seekFallbackTimer);
  seekFallbackTimer = setTimeout(() => {
    clearSeekRetryListeners(retry);
    // Give up cleanly: restore UI to the real playhead (do not jump to 0 via bad seek).
    pendingSeekTime = null;
    finishSeek();
  }, 20000);
  retry();
}

function onScrubberChange(e) {
  seekToPercent(e.target.value);
}

function formatTime(seconds) {
  if (isNaN(seconds)) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const formattedMins = String(mins).padStart(2, '0');
  const formattedSecs = String(secs).padStart(2, '0');

  if (hrs > 0) {
    const formattedHrs = String(hrs).padStart(2, '0');
    return `${formattedHrs}:${formattedMins}:${formattedSecs}`;
  }
  return `00:${formattedMins}:${formattedSecs}`;
}

function toggleMute() {
  const muted = !audio.muted;
  audio.muted = muted;
  audioIncoming.muted = muted;
  if (muted) {
    volIcon.className = 'fa-solid fa-volume-xmark';
  } else {
    if (!isMixing) {
      audio.volume = masterVolume();
    }
    updateVolumeIcon(masterVolume());
  }
}

function updateVolumeIcon(vol) {
  if (vol == 0) {
    volIcon.className = 'fa-solid fa-volume-xmark';
  } else if (vol < 0.5) {
    volIcon.className = 'fa-solid fa-volume-low';
  } else {
    volIcon.className = 'fa-solid fa-volume-high';
  }
}

function initEqBars() {
  const bars = document.querySelectorAll('#eqBars .bar');
  bars.forEach((bar, i) => {
    // Unique motion per bar: different delay, speed, and peak height
    const delay = ((i * 0.073) % 0.9) + Math.random() * 0.25;
    const duration = 0.32 + ((i * 0.047) % 0.5) + Math.random() * 0.2;
    const peak = 8 + ((i * 3) % 12) + Math.random() * 4;
    const min = 2 + (i % 3);
    bar.style.setProperty('--eq-delay', `${delay.toFixed(3)}s`);
    bar.style.setProperty('--eq-duration', `${duration.toFixed(3)}s`);
    bar.style.setProperty('--eq-peak', `${peak.toFixed(1)}px`);
    bar.style.setProperty('--eq-min', `${min}px`);
  });
}

function initLocationModal() {
  const locationBtn = document.getElementById('locationBtn');
  const locationModal = document.getElementById('locationModal');
  const locationClose = document.getElementById('locationClose');
  const locationBackdrop = document.getElementById('locationBackdrop');
  if (!locationBtn || !locationModal) return;

  const openLocation = () => {
    const map = document.getElementById('locationMap');
    if (map && !map.getAttribute('src') && map.dataset.src) {
      map.src = map.dataset.src;
    }
    locationModal.hidden = false;
    locationBtn.setAttribute('aria-expanded', 'true');
    locationClose?.focus();
  };

  const closeLocation = () => {
    locationModal.hidden = true;
    locationBtn.setAttribute('aria-expanded', 'false');
    locationBtn.focus();
  };

  locationBtn.addEventListener('click', () => {
    if (locationModal.hidden) openLocation();
    else closeLocation();
  });
  locationClose?.addEventListener('click', closeLocation);
  locationBackdrop?.addEventListener('click', closeLocation);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !locationModal.hidden) closeLocation();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initEqBars();
  initLocationModal();
  initPlayer();
});
