// Lappendag Rave Afterparty - Audio Engine
// Tracks are discovered by probing Lap-set/Lap_n.mp3 (needs HTTP(S), not file://).

const TRACK_DIR = 'Lap-set';
const TRACK_PREFIX = 'Lap_';
const SCAN_MISS_LIMIT = 3;
const SCAN_MAX = 500;
const SCAN_CONCURRENCY = 6;
const MY_LIST_KEY = 'lappendag-my-list';

const MIX_MIN_SEC = 2;
const MIX_MAX_SEC = 12;
const MIX_DEFAULT_SEC = 6;
/** Auto never picks shorter than this once analysis is ready. */
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
let mixRaf = null;
let mixBlendT = 0;
let mixStartOutPercent = 0;
let mixAudioCtx = null;
const mixAnalysisCache = new Map();

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
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const currentTitle = document.getElementById('currentTitle');
const nextTitle = document.getElementById('nextTitle');
const nowPlayingArt = document.getElementById('nowPlayingArt');
const playlistEl = document.getElementById('playlist');
const coverArtCache = new Map(); // file url -> objectURL | null
const disc = document.getElementById('disc');
const eqBars = document.getElementById('eqBars');
const tabAll = document.getElementById('tabAll');
const tabMyList = document.getElementById('tabMyList');

// State
let currentIndex = 0; // index in full `tracks` array
let isScanning = false;
let isPlaying = false;
let isSeeking = false;
let seekFallbackTimer = null;
let pendingSeekTime = null;
let autoMixPrepareTimer = null;
const SILENCE_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAIDRhYWR0AgAAAAEA';

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
  if (mixRaf != null) {
    cancelAnimationFrame(mixRaf);
    mixRaf = null;
  }
  isMixing = false;
  pendingMixIndex = -1;
  plannedNextIndex = -1;
  mixBlendT = 0;
  mixStartOutPercent = 0;
  clearDeck(audioIncoming);
  if (!audio.muted) {
    audio.volume = masterVolume();
  }
  setMixProgressUi(false);
}

function planNextIndex() {
  if (plannedNextIndex >= 0 && plannedNextIndex < tracks.length) {
    return plannedNextIndex;
  }
  plannedNextIndex = resolveNextIndex();
  return plannedNextIndex;
}

function updateNextTitle() {
  if (!nextTitle) return;
  if (!tracks.length) {
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

  if (nextIndex === currentIndex && getVisibleTracks().length <= 1) {
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
}

async function fileExists(url) {
  // cache: 'no-store' — tiny probe responses must not poison the audio cache
  // (that broke seeking on LAP_1 until a second full download).
  const probe = { method: 'HEAD', cache: 'no-store' };
  try {
    const head = await fetch(url, probe);
    if (head.ok) return true;
    // Some hosts disallow HEAD; fall back to a tiny GET (also uncached)
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      });
      return get.ok || get.status === 206;
    }
    return false;
  } catch {
    try {
      const get = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      });
      return get.ok || get.status === 206;
    } catch {
      return false;
    }
  }
}

function makeTrack(n) {
  const title = `${TRACK_PREFIX}${n}`;
  return { id: n, title, file: `${TRACK_DIR}/${title}.mp3` };
}

function updateTrackCountStatus() {
  const trackCountEl = document.getElementById('trackCount');
  if (!trackCountEl) return;
  if (isScanning) {
    trackCountEl.textContent = `Laden… ${tracks.length}`;
  } else {
    trackCountEl.textContent = `${getVisibleTracks().length}`;
  }
}

/** Batched progressive scan; invokes onFound for each existing file in order. */
async function scanTracksProgressive(startN, onFound) {
  let n = startN;
  let misses = 0;

  while (n <= SCAN_MAX && misses < SCAN_MISS_LIMIT) {
    const nums = [];
    for (let i = 0; i < SCAN_CONCURRENCY && n + i <= SCAN_MAX; i++) {
      nums.push(n + i);
    }

    const results = await Promise.all(
      nums.map(async (num) => {
        const track = makeTrack(num);
        const exists = await fileExists(track.file);
        return { track, exists };
      })
    );

    let stop = false;
    for (const { track, exists } of results) {
      if (exists) {
        misses = 0;
        onFound(track);
      } else {
        misses += 1;
        if (misses >= SCAN_MISS_LIMIT) {
          stop = true;
          break;
        }
      }
    }

    if (stop) break;
    n += nums.length;
  }
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
  renderPlaylist();
  updateNextTitle();
}

function indexInVisible(visible, globalIndex) {
  return visible.findIndex((t) => tracks.indexOf(t) === globalIndex || t.id === tracks[globalIndex]?.id);
}

async function initPlayer() {
  const lap1 = makeTrack(1);
  tracks = [lap1];
  isScanning = true;

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

  renderPlaylist();
  loadTrack(0, false);

  const lap1Ok = await fileExists(lap1.file);
  let startN = 2;

  if (!lap1Ok) {
    tracks = [];
    currentIndex = 0;
    currentTitle.textContent = 'Tracks laden...';
    if (audio.src) {
      audio.removeAttribute('src');
      audio.load();
    }
    renderPlaylist();
    startN = 1;
  }

  await scanTracksProgressive(startN, (track) => {
    if (tracks.some((t) => t.id === track.id)) return;
    tracks.push(track);
    tracks.sort((a, b) => a.id - b.id);
    renderPlaylist();
    if (!lap1Ok && tracks.length === 1) {
      loadTrack(0, false);
    }
  });

  isScanning = false;
  reconcileMyList();

  if (tracks.length === 0) {
    currentTitle.textContent = 'Geen tracks gevonden';
    playlistEl.innerHTML = '<p class="playlist-empty">Geen bestanden in Lap-set/ gevonden. Start een lokale server.</p>';
    const trackCountEl = document.getElementById('trackCount');
    if (trackCountEl) trackCountEl.textContent = '0';
    return;
  }

  if (currentIndex >= tracks.length) {
    loadTrack(0, false);
  }

  renderPlaylist();
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
  renderPlaylist();
  updateNextTitle();
  if (mixOn) {
    scheduleAutoMixPrepare();
  }
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

function getMixAudioContext() {
  if (!mixAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    mixAudioCtx = new Ctx();
  }
  if (mixAudioCtx.state === 'suspended') {
    mixAudioCtx.resume().catch(() => {});
  }
  return mixAudioCtx;
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

function buildRmsEnvelope(audioBuf, winSec) {
  const sr = audioBuf.sampleRate;
  const win = Math.max(1, Math.floor(sr * winSec));
  const n = Math.floor(audioBuf.length / win);
  const rms = new Float32Array(Math.max(0, n));
  if (n < 4) return { rms, winSec, peak: 0 };

  const channels = [];
  for (let c = 0; c < audioBuf.numberOfChannels; c++) {
    channels.push(audioBuf.getChannelData(c));
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * win;
    for (let j = 0; j < win; j++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) {
        v += channels[c][base + j];
      }
      v /= channels.length;
      sum += v * v;
    }
    rms[i] = Math.sqrt(sum / win);
    if (rms[i] > peak) peak = rms[i];
  }

  // Light smooth to ignore micro-gaps
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rms[Math.max(0, i - 1)];
    const b = rms[i];
    const c = rms[Math.min(n - 1, i + 1)];
    smooth[i] = (a + b * 2 + c) / 4;
  }
  return { rms: smooth, winSec, peak };
}

function regionPeak(rms, from, to) {
  let peak = 0;
  for (let i = from; i <= to; i++) {
    if (rms[i] > peak) peak = rms[i];
  }
  return peak;
}

function measureOutroSec(rms, winSec, globalPeak) {
  const n = rms.length;
  const silent = globalPeak * 0.04;
  let end = n - 1;
  while (end > 0 && rms[end] < silent) end -= 1;

  const lookBins = Math.min(end + 1, Math.floor(16 / winSec));
  const region0 = Math.max(0, end - lookBins + 1);
  const localPeak = regionPeak(rms, region0, end);
  if (localPeak < 1e-6) return 2.5;

  const high = localPeak * 0.72;
  const low = localPeak * 0.28;

  // Last moment energy was still "full"
  let lastHigh = region0;
  for (let i = end; i >= region0; i--) {
    if (rms[i] >= high) {
      lastHigh = i;
      break;
    }
  }

  // First moment after that we are clearly down (or end)
  let firstLow = end;
  for (let i = lastHigh; i <= end; i++) {
    if (rms[i] <= low) {
      firstLow = i;
      break;
    }
  }

  let outro = (firstLow - lastHigh) * winSec;

  // Still loud at the end → hard cut; use a musical default from the last-seconds slope
  if (lastHigh >= end - Math.floor(0.25 / winSec)) {
    const back = Math.max(region0, end - Math.floor(4 / winSec));
    const earlier = regionPeak(rms, back, Math.max(back, end - Math.floor(1 / winSec)));
    const ratio = earlier > 1e-6 ? rms[end] / earlier : 1;
    outro = ratio < 0.8 ? 4.5 + (1 - ratio) * 5 : 5.0;
  }

  const trailing = ((n - 1) - end) * winSec;
  outro += Math.min(trailing, 2.5) * 0.4;

  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, outro));
}

function measureIntroSec(rms, winSec, globalPeak) {
  const n = rms.length;
  const silent = globalPeak * 0.04;
  let start = 0;
  while (start < n - 1 && rms[start] < silent) start += 1;

  const lookBins = Math.min(n - start, Math.floor(16 / winSec));
  const region1 = Math.min(n - 1, start + lookBins - 1);
  const localPeak = regionPeak(rms, start, region1);
  if (localPeak < 1e-6) return 2.5;

  const high = localPeak * 0.7;
  let riseEnd = start;
  for (let i = start; i <= region1; i++) {
    riseEnd = i;
    if (rms[i] >= high) break;
  }

  let intro = (riseEnd - start) * winSec;
  const leading = start * winSec;
  intro += Math.min(leading, 2.5) * 0.35;

  // Cold open that hits full level immediately → still leave room for a mix-in
  if (riseEnd <= start + Math.floor(0.2 / winSec) && leading < 0.15) {
    intro = 4.5;
  }

  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, intro));
}

function analyzeMixPoints(audioBuf) {
  const { rms, winSec, peak } = buildRmsEnvelope(audioBuf, 0.05);
  if (rms.length < 4 || peak < 1e-5) {
    return { introSec: MIX_DEFAULT_SEC, outroSec: MIX_DEFAULT_SEC };
  }

  return {
    introSec: measureIntroSec(rms, winSec, peak),
    outroSec: measureOutroSec(rms, winSec, peak),
  };
}

async function analyzeTrackMixPoints(url) {
  if (mixAnalysisCache.has(url)) {
    return mixAnalysisCache.get(url);
  }

  const ctx = getMixAudioContext();
  // Low priority so the <audio> element keeps bandwidth for buffering/seek.
  const res = await fetch(url, { cache: 'force-cache', priority: 'low' });
  if (!res.ok) throw new Error(`Mix analyze fetch failed: ${url}`);
  const raw = await res.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(raw.slice(0));
  const points = analyzeMixPoints(audioBuf);
  mixAnalysisCache.set(url, points);
  return points;
}

async function computeAutoMixSec(currentUrl, nextUrl, trackDuration) {
  // Sequential downloads — parallel full-file fetches starved seeking on cold load.
  const next = await analyzeTrackMixPoints(nextUrl);
  const cur = await analyzeTrackMixPoints(currentUrl);

  // Blend outro of current with intro of next.
  let sec = cur.outroSec * 0.55 + next.introSec * 0.45;
  sec = clampAutoMixSec(sec);
  if (trackDuration && Number.isFinite(trackDuration) && trackDuration > 0) {
    sec = Math.min(sec, Math.max(AUTO_MIX_MIN_SEC, trackDuration * 0.4));
  }
  return Math.round(sec * 10) / 10;
}

function scheduleAutoMixPrepare() {
  if (!mixOn || !tracks.length) return;
  clearTimeout(autoMixPrepareTimer);

  const tryPrepare = () => {
    if (!mixOn) return;
    const remaining = audio.duration
      ? audio.duration - audio.currentTime
      : Infinity;
    // Keep network free for track 1 buffering/seek unless we're near a mix point.
    if (isPlaying && !mediaHasHealthyBuffer() && remaining > 45) {
      autoMixPrepareTimer = setTimeout(tryPrepare, 500);
      return;
    }
    if (isPlaying && !mediaCanSeek()) {
      autoMixPrepareTimer = setTimeout(tryPrepare, 400);
      return;
    }
    prepareAutoMix();
  };

  autoMixPrepareTimer = setTimeout(tryPrepare, mediaHasHealthyBuffer() ? 200 : 1200);
}

function prepareAutoMix() {
  if (!mixOn || !tracks.length) return;

  const nextIndex = planNextIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;

  const key = `${currentIndex}>${nextIndex}`;
  if (autoMixKey === key && autoMixSec != null && !autoMixPreparing) return;
  if (autoMixPreparing === key) return;

  autoMixPreparing = key;
  // Invalidate any previous pair so we never mix with a stale duration.
  autoMixKey = null;
  autoMixSec = null;
  updateMixDurationUi();

  const current = tracks[currentIndex];
  const next = tracks[nextIndex];
  if (!current || !next) {
    autoMixPreparing = null;
    return;
  }

  computeAutoMixSec(current.file, next.file, audio.duration)
    .then((sec) => {
      if (autoMixPreparing !== key) return;
      autoMixSec = sec;
      autoMixKey = key;
      autoMixPreparing = null;
      updateMixDurationUi();
      maybeStartMix();
    })
    .catch((err) => {
      console.error('Auto mix analyze failed:', err);
      if (autoMixPreparing !== key) return;
      autoMixSec = MIX_DEFAULT_SEC;
      autoMixKey = key;
      autoMixPreparing = null;
      updateMixDurationUi();
      maybeStartMix();
    });
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
  if (e.target !== audio) return;
  updateProgress();
  if (mixOn && audio.duration) {
    const remaining = audio.duration - audio.currentTime;
    // Start analysis once the player can seek; near the end insist on prepare.
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

function startMix(mixSec) {
  const nextIndex = planNextIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;

  isMixing = true;
  pendingMixIndex = nextIndex;
  const nextTrack = tracks[nextIndex];

  audioIncoming.src = nextTrack.file;
  audioIncoming.playbackRate = 1;
  audioIncoming.muted = audio.muted;
  audioIncoming.volume = 0;

  audioIncoming.play().then(() => {
    mixStartOutPercent = audio.duration
      ? (audio.currentTime / audio.duration) * 100
      : 0;
    mixBlendT = 0;
    setMixProgressUi(true);
    const t0 = performance.now();
    const durationMs = mixSec * 1000;

    const frame = (now) => {
      if (!isMixing) return;
      const rawT = Math.min(1, (now - t0) / durationMs);
      const t = easeMix(rawT);
      mixBlendT = t;
      const m = masterVolume();
      if (!audio.muted) {
        audio.volume = m * (1 - t);
        audioIncoming.volume = m * t;
      }
      updateProgress();
      if (rawT < 1) {
        mixRaf = requestAnimationFrame(frame);
      } else {
        finishMix(nextIndex);
      }
    };
    mixRaf = requestAnimationFrame(frame);
  }).catch((err) => {
    console.error('Mix start failed:', err);
    cancelMix();
  });
}

function finishMix(nextIndex) {
  if (mixRaf != null) {
    cancelAnimationFrame(mixRaf);
    mixRaf = null;
  }

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

  // Hand off without a flash: main fill matches new track + thumb mapping.
  const handoffPercent = audio.duration
    ? (audio.currentTime / audio.duration) * 100
    : 0;
  setRangeAndFill(handoffPercent);
  if (progressFill) progressFill.style.opacity = '1';
  if (progressFillIncoming) {
    progressFillIncoming.style.opacity = '0';
    progressFillIncoming.style.width = `${fillWidthFromRangeValue(handoffPercent)}%`;
  }
  setMixProgressUi(false);

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

function renderPlaylist() {
  const visible = getVisibleTracks();
  updateTrackCountStatus();

  playlistEl.innerHTML = '';

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

    if (activeTab === 'mylist') {
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

function playTrack() {
  if (!tracks.length) return;
  audio.play().then(() => {
    unlockAudioDecks();
    getMixAudioContext();
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
  cancelMix();
  const nextIndex = resolveNextIndex();
  if (nextIndex < 0) return;
  loadTrack(nextIndex, true);
}

function playPrevious() {
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
  if (!on && progressFillIncoming) {
    // Keep width; only fade — resetting to 0% caused a visible flash.
    progressFillIncoming.style.opacity = '0';
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

function setRangeAndFill(valuePercent, fillEl = progressFill) {
  const v = Math.max(0, Math.min(100, Number(valuePercent) || 0));
  if (fillEl === progressFill) {
    progressBar.value = v;
  }
  if (fillEl) {
    fillEl.style.width = `${fillWidthFromRangeValue(v)}%`;
  }
}

function updateProgress() {
  if (isSeeking) return;

  if (isMixing && progressFillIncoming) {
    setMixProgressUi(true);
    const t = mixBlendT;
    const outP = mixStartOutPercent + (100 - mixStartOutPercent) * t;
    let inP = 0;
    if (audioIncoming.duration && Number.isFinite(audioIncoming.duration) && audioIncoming.duration > 0) {
      inP = (audioIncoming.currentTime / audioIncoming.duration) * 100;
    }
    // Base fill stays normal cyan→lime and moves to the new playhead.
    // Pink only peaks mid-mix (sin) so it fades out before handoff — no purple→yellow snap.
    const blended = outP * (1 - t) + inP * t;
    const pinkPeak = Math.sin(t * Math.PI);
    progressBar.value = blended;
    if (progressFill) {
      progressFill.style.width = `${fillWidthFromRangeValue(blended)}%`;
      progressFill.style.opacity = '1';
    }
    progressFillIncoming.style.width = `${fillWidthFromRangeValue(inP)}%`;
    progressFillIncoming.style.opacity = String(pinkPeak);
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
    progressFillIncoming.style.opacity = '0';
  }
}

function onScrubberInput(e) {
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
  if (!audio.duration || Number.isNaN(audio.duration)) {
    isSeeking = false;
    return;
  }

  if (isMixing) {
    cancelMix();
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
