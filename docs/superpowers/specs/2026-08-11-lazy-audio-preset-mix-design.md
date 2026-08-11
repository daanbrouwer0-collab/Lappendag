# Lazy audio load + preset mix points

Date: 2026-08-11  
Status: approved in chat

## Goal

Make the site show meaningful UI immediately (title, location, time) and avoid downloading music until the user presses Play. Keep good auto-mix quality by precomputing intro/outro points offline into a preset track list. Buffer at most the current track plus (later) the planned next track — never the whole library.

This supersedes the earlier “bootstrap Lap_1 + progressive HEAD scan” direction for track discovery when the set is fixed (`Lap_1`…`Lap_153`).

## Requirements

1. **Instant first paint:** On open, user sees `LAPPENDAG AFTERPARTY`, location control, and time (`17:00`) without waiting for audio.
2. **No audio until Play:** Neither deck sets `src` to an MP3 before the first Play (or explicit track select). Audio elements use `preload="none"`.
3. **First track on Play (shuffle default):** On first Play with shuffle on, pick a random track from the visible list, then load and play it.
4. **Preset track list:** Fixed catalog in `tracks.json` (ids 1…153, no gaps). No runtime `fileExists` / HEAD scan.
5. **Preset mix analysis:** Each track has `introSec` and `outroSec` from an offline, thorough analysis script. Runtime auto-mix is a lookup + blend only — no full-file (or Range) analysis fetches during playback.
6. **Conservative buffering:** After Play, only the current track downloads. Once current has a healthy ~15s buffer, start buffering the planned next on the incoming deck. Drop/replan next when shuffle, tab, or selection changes.
7. **Lazy location map:** Do not download `locatie.png` (~5.6MB) until the location modal opens.

## Non-goals

- Service worker / offline cache of the library.
- Compressing or replacing `Haven.jpg` / `locatie.png` (lazy map only).
- Visual redesign of the player.
- Autoplay without user gesture.
- Keeping progressive HEAD scanning as the primary discovery path.

## Decisions (from brainstorm)

| Topic | Choice |
|-------|--------|
| First track | Pick only on Play (random if shuffle) |
| Mix quality | Good analysis, precomputed offline into preset |
| Next full buffer | After current ~15s healthy buffer |
| Catalog | Preset list (set is closed) |
| Analysis fill | One-time local script → `tracks.json` |

## Architecture

### A. First paint & load phases

| Phase | Behavior |
|-------|----------|
| Open | HTML/CSS only. No MP3 `src`. No cover fetch. No mix analysis network. Location map not requested. |
| Boot | Fetch small `tracks.json`. Fill playlist. Player idle (e.g. “Druk play” / empty now-playing). |
| Play | Resolve first index (shuffle random or sequential). Set deck A `src`, play. Plan `plannedNextIndex`. Show next title. |
| During play | When `mediaHasHealthyBuffer()` (~15s ahead or near end): set incoming deck `src` to planned next and let browser buffer (paused / volume 0 until mix). Mix duration from preset. |
| Mix / Next | Existing dual-deck crossfade using buffered next; then replan and repeat. |

### B. `tracks.json`

```json
{
  "tracks": [
    {
      "id": 1,
      "title": "Lap_1",
      "file": "Lap-set/Lap_1.mp3",
      "introSec": 4.2,
      "outroSec": 5.8
    }
  ]
}
```

- Generated once offline; committed with the site.
- Regenerate only when tracks are added/replaced.
- Runtime: replace progressive scan with a single JSON load; build `tracks` array from it.

### C. Offline analysis script

- Path: `scripts/analyze-tracks.mjs` (Node; same RMS intro/outro idea as `app.js`, run offline on full files).
- Input: all `Lap-set/Lap_*.mp3`.
- Output: `tracks.json` with thorough **intro** (energy rise at start) and **outro** (energy fall at end) measurements.
- May refine windows/thresholds vs the in-browser version because cost is offline-only.
- Clamp results to the same mix bounds used in the player (`AUTO_MIX_MIN_SEC`…`MIX_MAX_SEC`).

### D. Runtime auto-mix (no analysis download)

```
mixSec = clampAutoMixSec(
  current.outroSec * 0.55 + next.introSec * 0.45
)
```

- Cap vs track duration as today (`effectiveMixSeconds`).
- Fallback `MIX_DEFAULT_SEC` (6s) if fields missing.
- Remove (or stop calling) runtime `analyzeTrackMixPoints` / full `fetch` + `decodeAudioData` for mix prep.
- `scheduleAutoMixPrepare` becomes: plan next index, compute mixSec from preset, optionally ensure next deck is buffering — no network analysis.

### E. Shuffle / next buffering rules

1. On first Play (shuffle): random visible track → load → play.
2. Immediately `planNextIndex()` (different track when possible); update next title UI only.
3. Start buffering next on deck B only after current has ~15s healthy buffer.
4. On shuffle toggle, All/My list tab change, or manual track select: cancel mix, clear incoming deck, reset planned next + mixSec, replan after new current is playing.
5. If mix window arrives but next is not ready: prefer waiting briefly / shorter live fade; avoid preloading the whole catalog to compensate.
6. Cover art: load only for the current track after it becomes the active selection (post-Play / post-select), not on cold open.

### F. HTML / asset tweaks

- `<audio … preload="none">` on both decks.
- Location modal image: set `src` only when opening the modal (or use lazy pattern that does not request until open).
- Idle copy in `#currentTitle` until first Play (not “Laden…” waiting on Lap_1).

## Data flow

```
Page open
  → paint shell (title, location, time)
  → fetch tracks.json
  → render playlist (metadata only)

User hits Play
  → pick random (shuffle) / first visible
  → deck A loads that MP3 only
  → plan next index (name only)

~15s healthy buffer on current
  → deck B src = planned next (buffer)
  → mixSec = f(outro current, intro next) from JSON

Near end + mix on
  → crossfade decks as today
  → swap active deck, clear old, replan next
```

## Error handling

- `tracks.json` missing/invalid: show clear empty state; Play disabled.
- Track file 404 after Play: show error on that title; allow Next / another pick.
- Missing intro/outro fields: use `MIX_DEFAULT_SEC`.
- Next not buffered in time for mix: degrade gracefully (shorter fade or cut) without starting extra downloads of unrelated tracks.
- Location map fetch failure: keep dialog usable with alt text / retry on reopen.

## Testing

1. Cold load with empty cache: title/location/time visible immediately; Network shows no MP3 until Play; no `locatie.png` until modal open.
2. First Play with shuffle: exactly one MP3 starts; title updates; later a second MP3 appears only after healthy buffer.
3. Mix on: crossfade uses preset-derived duration; Network has no full-file analysis fetches of non-current/non-next tracks.
4. Shuffle toggle / My list / click other track: incoming buffer cleared and replanned; no pile-up of downloads.
5. Regenerate script on sample tracks: intro/outro sane and within clamp range; player mix duration UI matches lookup.
6. Mobile + desktop: first paint still instant; Play still works after gesture.

## Implementation notes

- Touch: `app.js` (init, loadTrack gating, remove scan, preset mix), `index.html` (preload, idle title, lazy map), new `tracks.json`, new `scripts/analyze-tracks.*`.
- Keep dual-deck mix UI/animation behavior; change *when* and *how* media + mixSec are prepared.
- Do not push to remote until the user asks (local commits only for this workstream unless requested).
