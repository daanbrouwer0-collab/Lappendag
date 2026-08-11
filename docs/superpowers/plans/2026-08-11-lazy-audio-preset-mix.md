# Lazy Audio + Preset Mix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instant first paint with no MP3 downloads until Play; fixed `tracks.json` catalog with offline intro/outro; buffer only current (+ next after ~15s healthy buffer).

**Architecture:** Replace progressive HEAD scan and runtime full-file mix analysis with a preset JSON catalog. A Node offline script analyzes every MP3 once and writes `introSec`/`outroSec`. The browser player loads metadata only at boot, assigns audio `src` on Play/select, computes mix duration from the preset, and warms the incoming deck only after the current track has a healthy buffer.

**Tech Stack:** Vanilla HTML/CSS/JS (`app.js`, `index.html`), Node.js built-in `node:test` + `node:assert` for pure helpers, Node analysis script (`scripts/analyze-tracks.mjs`) using `ffmpeg` CLI to decode audio for RMS analysis.

## Global Constraints

- Do **not** push to remote unless the user explicitly asks.
- No audio `src` to an MP3 before first Play or explicit track select; both `<audio>` elements use `preload="none"`.
- No runtime mix-analysis network fetches (`analyzeTrackMixPoints` full/Range downloads removed).
- Buffer at most current + planned next; never preload the catalog.
- Location map `locatie.png` must not download until the modal opens.
- Catalog is closed: `Lap_1`…`Lap_153` via `tracks.json`.
- Keep existing dual-deck crossfade UI/behavior; only change *when/how* media and `mixSec` are prepared.
- Idle now-playing copy until first Play (e.g. `Druk play`), not `Laden...` waiting on Lap_1.

## File Structure

| File | Responsibility |
|------|----------------|
| `scripts/mix-analysis.mjs` | Pure RMS intro/outro + `blendMixSec` helpers (shared by analyzer + tests) |
| `scripts/analyze-tracks.mjs` | Offline CLI: decode each MP3 via ffmpeg, write `tracks.json` |
| `scripts/mix-analysis.test.mjs` | Unit tests for blend + intro/outro helpers |
| `tracks.json` | Generated catalog: id, title, file, introSec, outroSec |
| `index.html` | `preload="none"`, idle title, lazy location image |
| `app.js` | Load preset, lazy Play, preset mixSec, next-deck warm buffer; remove scan + runtime analyze fetch |
| `package.json` | Optional tiny package only if needed for `"type":"module"` / test script — prefer plain Node without deps |

---

### Task 1: Pure mix-analysis helpers + unit tests

**Files:**
- Create: `scripts/mix-analysis.mjs`
- Create: `scripts/mix-analysis.test.mjs`

**Interfaces:**
- Produces:
  - `export const MIX_MIN_SEC = 2`
  - `export const MIX_MAX_SEC = 12`
  - `export const MIX_DEFAULT_SEC = 6`
  - `export const AUTO_MIX_MIN_SEC = 3.5`
  - `export function clampAutoMixSec(sec: number): number`
  - `export function blendMixSec(outroSec: number, introSec: number, trackDuration?: number|null): number`
  - `export function buildRmsEnvelope(samples: Float32Array, sampleRate: number, winSec?: number): { rms: Float32Array, winSec: number, peak: number }`
  - `export function measureIntroSec(rms: Float32Array, winSec: number, globalPeak: number): number`
  - `export function measureOutroSec(rms: Float32Array, winSec: number, globalPeak: number): number`
  - `export function analyzeMixPointsFromMono(samples: Float32Array, sampleRate: number): { introSec: number, outroSec: number }`

- [ ] **Step 1: Write failing tests**

Create `scripts/mix-analysis.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  blendMixSec,
  clampAutoMixSec,
  AUTO_MIX_MIN_SEC,
  MIX_MAX_SEC,
  MIX_DEFAULT_SEC,
  analyzeMixPointsFromMono,
} from './mix-analysis.mjs';

describe('clampAutoMixSec', () => {
  it('clamps below min up to AUTO_MIX_MIN_SEC', () => {
    assert.equal(clampAutoMixSec(1), AUTO_MIX_MIN_SEC);
  });
  it('clamps above max down to MIX_MAX_SEC', () => {
    assert.equal(clampAutoMixSec(99), MIX_MAX_SEC);
  });
});

describe('blendMixSec', () => {
  it('blends outro*0.55 + intro*0.45 and rounds to 0.1s', () => {
    // 5*0.55 + 7*0.45 = 2.75+3.15 = 5.9
    assert.equal(blendMixSec(5, 7), 5.9);
  });
  it('falls back toward defaults via clamp when tiny', () => {
    assert.equal(blendMixSec(0.1, 0.1), AUTO_MIX_MIN_SEC);
  });
  it('caps against short track duration', () => {
    const sec = blendMixSec(10, 10, 8); // raw ~10, duration*0.4 = 3.2 → clamp to AUTO_MIX_MIN_SEC
    assert.equal(sec, AUTO_MIX_MIN_SEC);
  });
});

describe('analyzeMixPointsFromMono', () => {
  it('detects cold-open-ish intro and trailing outro on synthetic audio', () => {
    const sr = 1000;
    const seconds = 20;
    const samples = new Float32Array(sr * seconds);
    // silence 0-1s, then full level, then fade 16-20s
    for (let i = 0; i < samples.length; i++) {
      const t = i / sr;
      if (t < 1) samples[i] = 0;
      else if (t < 16) samples[i] = 0.5;
      else samples[i] = 0.5 * (1 - (t - 16) / 4);
    }
    const { introSec, outroSec } = analyzeMixPointsFromMono(samples, sr);
    assert.ok(introSec >= AUTO_MIX_MIN_SEC && introSec <= MIX_MAX_SEC);
    assert.ok(outroSec >= AUTO_MIX_MIN_SEC && outroSec <= MIX_MAX_SEC);
    assert.ok(outroSec >= 3, `expected meaningful outro, got ${outroSec}`);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test scripts/mix-analysis.test.mjs`

Expected: FAIL (module not found / exports missing)

- [ ] **Step 3: Implement `scripts/mix-analysis.mjs`**

Port the RMS logic from `app.js` (`buildRmsEnvelope`, `measureIntroSec`, `measureOutroSec`, `analyzeMixPoints`, clamps) into pure functions that take a mono `Float32Array` + `sampleRate` (no Web Audio / fetch).

```js
export const MIX_MIN_SEC = 2;
export const MIX_MAX_SEC = 12;
export const MIX_DEFAULT_SEC = 6;
export const AUTO_MIX_MIN_SEC = 3.5;

export function clampAutoMixSec(sec) {
  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, sec));
}

export function blendMixSec(outroSec, introSec, trackDuration = null) {
  let sec = Number(outroSec) * 0.55 + Number(introSec) * 0.45;
  sec = clampAutoMixSec(sec);
  if (trackDuration && Number.isFinite(trackDuration) && trackDuration > 0) {
    sec = Math.min(sec, Math.max(AUTO_MIX_MIN_SEC, trackDuration * 0.4));
  }
  return Math.round(sec * 10) / 10;
}

// Port buildRmsEnvelope / measureIntroSec / measureOutroSec from app.js
// adapting channel loops to a single Float32Array of mono samples.

export function analyzeMixPointsFromMono(samples, sampleRate) {
  const { rms, winSec, peak } = buildRmsEnvelope(samples, sampleRate, 0.05);
  if (rms.length < 4 || peak < 1e-5) {
    return { introSec: MIX_DEFAULT_SEC, outroSec: MIX_DEFAULT_SEC };
  }
  return {
    introSec: measureIntroSec(rms, winSec, peak),
    outroSec: measureOutroSec(rms, winSec, peak),
  };
}
```

Copy `measureIntroSec` / `measureOutroSec` / envelope smoothing from `app.js` lines ~750–885, adjusting `buildRmsEnvelope` to accept `(samples, sampleRate, winSec)` instead of an `AudioBuffer`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test scripts/mix-analysis.test.mjs`

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/mix-analysis.mjs scripts/mix-analysis.test.mjs
git commit -m "$(cat <<'EOF'
Add pure mix intro/outro helpers with unit tests.

EOF
)"
```

---

### Task 2: Offline analyzer CLI → `tracks.json`

**Files:**
- Create: `scripts/analyze-tracks.mjs`
- Create: `tracks.json` (generated)
- Consumes: `scripts/mix-analysis.mjs` exports from Task 1

**Interfaces:**
- Consumes: `analyzeMixPointsFromMono`, clamp constants from `./mix-analysis.mjs`
- Produces: repo-root `tracks.json` with shape `{ tracks: Array<{ id, title, file, introSec, outroSec }> }`
- CLI: `node scripts/analyze-tracks.mjs` (requires `ffmpeg` on PATH)

- [ ] **Step 1: Verify ffmpeg is available**

Run: `ffmpeg -version | head -n 1`

Expected: version line printed. If missing, install ffmpeg before continuing (`sudo apt install ffmpeg` or equivalent).

- [ ] **Step 2: Implement `scripts/analyze-tracks.mjs`**

```js
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMixPointsFromMono } from './mix-analysis.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SET_DIR = path.join(ROOT, 'Lap-set');
const OUT = path.join(ROOT, 'tracks.json');
const SAMPLE_RATE = 8000; // enough for RMS energy; keeps decode lighter

function decodeMonoF32(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', filePath,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      '-v', 'error',
      'pipe:1',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c.toString(); });
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed for ${filePath}: ${err || code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    });
  });
}

function parseLapId(name) {
  const m = /^Lap_(\d+)\.mp3$/i.exec(name);
  return m ? Number(m[1]) : null;
}

async function main() {
  const names = (await readdir(SET_DIR))
    .filter((n) => parseLapId(n) != null)
    .sort((a, b) => parseLapId(a) - parseLapId(b));

  if (!names.length) {
    throw new Error(`No Lap_*.mp3 in ${SET_DIR}`);
  }

  const tracks = [];
  for (const name of names) {
    const id = parseLapId(name);
    const filePath = path.join(SET_DIR, name);
    process.stderr.write(`Analyzing ${name}...\n`);
    const samples = await decodeMonoF32(filePath);
    const { introSec, outroSec } = analyzeMixPointsFromMono(samples, SAMPLE_RATE);
    tracks.push({
      id,
      title: `Lap_${id}`,
      file: `Lap-set/Lap_${id}.mp3`,
      introSec,
      outroSec,
    });
  }

  const payload = { tracks };
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stderr.write(`Wrote ${tracks.length} tracks → ${OUT}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run analyzer (long — ~153 files)**

Run: `node scripts/analyze-tracks.mjs`

Expected: stderr progress per file; `tracks.json` created with 153 entries; each has numeric `introSec`/`outroSec` in `[3.5, 12]`.

Quick check:

```bash
node -e "const t=require('./tracks.json'); console.log(t.tracks.length, t.tracks[0], t.tracks.at(-1))"
```

Expected: `153` and first/last objects with `introSec`/`outroSec`.

- [ ] **Step 4: Commit**

```bash
git add scripts/analyze-tracks.mjs tracks.json
git commit -m "$(cat <<'EOF'
Add offline track analyzer and generate tracks.json mix points.

EOF
)"
```

---

### Task 3: HTML first-paint tweaks (preload, idle title, lazy map)

**Files:**
- Modify: `index.html` (audio tags, `#currentTitle`, location `<img>`)
- Modify: `app.js` only if `initLocationModal` needs a `src` assignment (preferred: do map lazy in `app.js` Task 3 steps below — keep HTML without eager `src`)

**Interfaces:**
- Produces: no MP3 preload; `#currentTitle` idle text `Druk play`; `#locationMap` (or existing img) without initial `src` / with `data-src="locatie.png"`

- [ ] **Step 1: Update audio + idle title in `index.html`**

Change:

```html
<audio id="audioPlayer" preload="auto"></audio>
<audio id="audioPlayerB" preload="auto"></audio>
```

to:

```html
<audio id="audioPlayer" preload="none"></audio>
<audio id="audioPlayerB" preload="none"></audio>
```

Change current title default:

```html
<h2 class="current-title" id="currentTitle">Laden...</h2>
```

to:

```html
<h2 class="current-title" id="currentTitle">Druk play</h2>
```

Change location image from eager `src` to lazy data attribute:

```html
<img class="location-map" id="locationMap" data-src="locatie.png" alt="Kaart: Uit het water en uit je bol, Buitenhaven Hoorn">
```

- [ ] **Step 2: Lazy-load map in `initLocationModal` (`app.js`)**

In `openLocation`, before showing modal:

```js
const map = document.getElementById('locationMap');
if (map && !map.getAttribute('src') && map.dataset.src) {
  map.src = map.dataset.src;
}
```

- [ ] **Step 3: Manual check**

Run local server (`python serve.py` or existing), open DevTools Network, hard-reload:

- `locatie.png` must **not** appear until location button click
- No `Lap-set/*.mp3` requests yet (may still see old scan until Task 4/5 — after this task alone, scan may still run; acceptable if only HTML/map verified)

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "$(cat <<'EOF'
Defer audio preload and load location map only on open.

EOF
)"
```

---

### Task 4: Load `tracks.json` and remove progressive scan

**Files:**
- Modify: `app.js` (`initPlayer`, remove/stop using `scanTracksProgressive` / `fileExists` for boot)
- Consumes: `tracks.json` from Task 2

**Interfaces:**
- Produces: `async function loadTracksManifest(): Promise<void>` that sets global `tracks` from JSON
- Track objects must include `introSec` and `outroSec` number fields
- On failure: empty playlist message, Play remains no-op until tracks exist

- [ ] **Step 1: Add manifest loader**

Near track helpers in `app.js`:

```js
async function loadTracksManifest() {
  const res = await fetch('tracks.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`tracks.json HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.tracks) || !data.tracks.length) {
    throw new Error('tracks.json missing tracks[]');
  }
  tracks = data.tracks.map((t) => ({
    id: Number(t.id),
    title: String(t.title || `Lap_${t.id}`),
    file: String(t.file || `${TRACK_DIR}/${TRACK_PREFIX}${t.id}.mp3`),
    introSec: Number(t.introSec),
    outroSec: Number(t.outroSec),
  })).sort((a, b) => a.id - b.id);
}
```

- [ ] **Step 2: Rewrite `initPlayer` boot path**

Replace Lap_1 bootstrap + `scanTracksProgressive` with:

1. Bind controls / listeners (keep existing)
2. `isScanning = false`
3. Do **not** call `loadTrack(0, false)`
4. `await loadTracksManifest()` inside try/catch
5. `reconcileMyList(); renderPlaylist(); updateNextTitle(); updateTrackCountStatus();`
6. On error: `tracks = []; currentTitle.textContent = 'Geen tracks gevonden';` + empty playlist message

Remove dead code paths that only served scanning (`SCAN_*` usage, `fileExists` if unused, `scanTracksProgressive`) once nothing calls them. Keep `makeTrack` only if still useful; otherwise delete.

- [ ] **Step 3: Verify in browser**

Hard reload: playlist shows 153 tracks quickly; Network has `tracks.json` but **still** should not load MP3 if Task 5 not done yet — if `loadTrack` still called, fix by ensuring init does not set `audio.src`.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
Load fixed tracks.json catalog and drop HEAD scan.

EOF
)"
```

---

### Task 5: Lazy first Play (shuffle pick) — no MP3 until gesture

**Files:**
- Modify: `app.js` (`playTrack`, `togglePlay`, `loadTrack`, `selectTrack`, idle state)

**Interfaces:**
- Produces:
  - `let hasStarted = false` (or derive from “no src yet”)
  - `function pickStartIndex(): number` — shuffle → `resolveNextIndex()`-style random among visible; else first visible
  - First Play with no current media: pick index → `loadTrack(index, true)`
  - Playlist click still calls `loadTrack(globalIndex, true)` (allowed by spec)

- [ ] **Step 1: Add start-index helper**

```js
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
```

- [ ] **Step 2: Gate `togglePlay` / `playTrack`**

At start of `playTrack`:

```js
function playTrack() {
  if (!tracks.length) return;
  if (!deckHasTrackSrc()) {
    const idx = pickStartIndex();
    if (idx < 0) return;
    loadTrack(idx, true);
    return;
  }
  // existing audio.play() path...
}
```

Ensure `initPlayer` never sets `audio.src` to an MP3. Idle UI: `currentTitle` stays `Druk play` until first `loadTrack`.

- [ ] **Step 3: `loadTrack` still cancels mix / plans next as today**

Keep `loadTrack` behavior for setting `src`, titles, cover (cover only here — OK after Play/select). After `loadTrack`, `updateNextTitle()` / `planNextIndex()` run as now.

- [ ] **Step 4: Manual Network test**

Hard reload → Play:

1. Before Play: zero `Lap-set/*.mp3`
2. After Play: exactly one MP3 (the shuffled pick)
3. Title updates from `Druk play` to `Lap_N`

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
Start audio only on Play with shuffle-aware first pick.

EOF
)"
```

---

### Task 6: Preset mixSec — remove runtime analysis downloads

**Files:**
- Modify: `app.js` (`prepareAutoMix`, `computeAutoMixSec`, delete/stop `analyzeTrackMixPoints`, `mixAnalysisCache`, `getMixAudioContext` if only used for analysis)

**Interfaces:**
- Consumes: `track.introSec` / `track.outroSec` from manifest
- Produces: synchronous `computeAutoMixSecFromTracks(current, next, duration) → number` using same blend as `blendMixSec` (inline duplicate of formula is OK to avoid bundling Node modules in browser; keep constants already in `app.js`)

- [ ] **Step 1: Replace async analyze path**

```js
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

function prepareAutoMix() {
  if (!mixOn || !tracks.length) return;
  const nextIndex = planNextIndex();
  if (nextIndex < 0 || nextIndex === currentIndex) return;
  const key = `${currentIndex}>${nextIndex}`;
  if (autoMixKey === key && autoMixSec != null) return;

  const current = tracks[currentIndex];
  const next = tracks[nextIndex];
  autoMixPreparing = null;
  autoMixSec = computeAutoMixSecFromTracks(current, next, audio.duration);
  autoMixKey = key;
  updateMixDurationUi();
  maybeStartMix();
  ensureNextBuffered(); // added in Task 7; stub no-op until then
}
```

- [ ] **Step 2: Delete runtime decode/fetch analysis**

Remove `analyzeTrackMixPoints`, old async `computeAutoMixSec`, `mixAnalysisCache`, and `getMixAudioContext` **if** nothing else needs AudioContext (unlock path currently calls `getMixAudioContext()` in `playTrack` — remove that call if context was only for analysis).

Simplify `scheduleAutoMixPrepare` to call `prepareAutoMix` without waiting on analysis downloads (may still wait for `mediaCanSeek` / healthy buffer before warming next — Task 7).

- [ ] **Step 3: Verify Network during play**

Play a track with Mix on: confirm **no** extra full-file fetches of random tracks for analysis. Only current (and later next) MP3.

Mix duration label should show a number (e.g. `5.9s`) shortly after next is planned, not hang on `…` waiting for decode.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
Drive auto-mix duration from preset intro/outro fields.

EOF
)"
```

---

### Task 7: Warm next deck after ~15s healthy buffer

**Files:**
- Modify: `app.js` (`ensureNextBuffered`, `cancelMix` / replan paths, `startMix`)

**Interfaces:**
- Produces:
  - `function ensureNextBuffered(): void` — if playing, mix/next planned, healthy buffer, and incoming deck not already that file → set `audioIncoming.src`, `preload` via src, `volume = 0`, do not `play()` until mix/next
  - Called from `prepareAutoMix`, `onAudioTimeUpdate` when healthy, and after `loadTrack` schedules prepare
- On shuffle/tab/select/`cancelMix`: clear incoming if not actively mixing

- [ ] **Step 1: Implement buffer helper**

```js
function incomingAlreadyHas(file) {
  const src = audioIncoming.currentSrc || audioIncoming.getAttribute('src') || '';
  return src.endsWith(file) || src.includes(file);
}

function ensureNextBuffered() {
  if (!tracks.length || isMixing) return;
  if (!isPlaying || !mediaHasHealthyBuffer()) return;
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
```

Wire into `prepareAutoMix` and keep `startMix` using existing play-on-incoming (if already buffered, `play()` should start quickly).

- [ ] **Step 2: Invalidate incoming on replan**

When `plannedNextIndex` is cleared / changed in `toggleShuffle`, `setTab`, `loadTrack`, `cancelMix`: if not mixing, `clearDeck(audioIncoming)` so a stale next does not keep downloading.

- [ ] **Step 3: Manual test**

1. Play → only 1 MP3  
2. After ~15s buffer: second MP3 request for planned next  
3. Toggle shuffle: old next request aborted/cleared; new next after healthy buffer again  
4. Near end with Mix on: crossfade still works

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
Buffer planned next track only after a healthy current buffer.

EOF
)"
```

---

### Task 8: End-to-end verification checklist

**Files:**
- None required (manual); fix any regressions found in `app.js` / `index.html` with a follow-up commit

- [ ] **Step 1: Cold-load checklist**

Hard reload empty cache:

- [ ] Title `LAPPENDAG AFTERPARTY`, location button, `17:00` visible immediately  
- [ ] `#currentTitle` shows `Druk play`  
- [ ] Network: `tracks.json` yes; `Lap-set/*.mp3` no; `locatie.png` no  
- [ ] Playlist lists 153 tracks  

- [ ] **Step 2: Play / shuffle / mix checklist**

- [ ] First Play downloads exactly one MP3  
- [ ] After healthy buffer, planned next appears as second MP3  
- [ ] Mix duration from preset; no analysis full-file fetches of other tracks  
- [ ] Crossfade still audible/visual  
- [ ] Location modal click loads `locatie.png` once  

- [ ] **Step 3: Regression checklist**

- [ ] My list add/remove/reorder still works  
- [ ] Next/Prev/select track behave  
- [ ] Mute/volume/scrub still work on current deck  

- [ ] **Step 4: Commit only if fixes were needed**

```bash
git add -u
git commit -m "$(cat <<'EOF'
Fix lazy-load regressions found in end-to-end checks.

EOF
)"
```

(Skip empty commit if clean.)

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Instant first paint | 3, 4, 5 |
| No audio until Play | 3, 5 |
| First track on Play (shuffle) | 5 |
| Preset catalog | 2, 4 |
| Offline intro/outro analysis | 1, 2 |
| Runtime mix = lookup blend | 6 |
| Next buffer after ~15s | 7 |
| Lazy location map | 3 |
| Remove scan / runtime analyze fetch | 4, 6 |
| E2E testing | 8 |

## Placeholder / consistency notes

- Browser keeps its own `blend` constants (cannot import Node ESM from plain script tag without a bundler) — formula duplicated intentionally in Task 6; tests lock the Node copy.
- `ensureNextBuffered` is stubbed in Task 6 text and fully implemented in Task 7 — implement Task 6 without calling it, or add an empty `function ensureNextBuffered() {}` in Task 6 then fill in Task 7.
- Do not push unless user asks.
