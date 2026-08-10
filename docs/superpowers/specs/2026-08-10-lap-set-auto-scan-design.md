# Lappendag track auto-scan design

Date: 2026-08-10  
Status: approved in chat (approach 1)

## Goal

Playlist mirrors `Lap-set/` without hand-editing track metadata. Today there are 13 files (`LAP_1.mp3` … `LAP_13.mp3`); more may be added later. Do not push until the user asks.

## Requirements

- Title = filename without `.mp3` (e.g. `LAP_1`).
- No custom tags / genre labels.
- New sequential files (`LAP_14.mp3`, …) appear after a page reload when served over HTTP(S).
- Existing player behavior (play/pause, next/prev, scrubber, speed, volume, EQ/disc UI) stays as-is.

## Approach

**Sequential HEAD/GET probe** of `Lap-set/LAP_{n}.mp3` starting at `n = 1`.

1. On `DOMContentLoaded`, before binding controls that need a track list, run an async scan.
2. For each `n`, request the file with `fetch(url, { method: 'HEAD' })`. If HEAD is not allowed by the host, fall back to a ranged/GET check or `audio`/`fetch` GET that can confirm existence (prefer HEAD; if response is opaque/failed due to method, use GET and abort reading the body when status is ok).
3. If the file exists, append `{ id: n, title: 'LAP_n', file: 'Lap-set/LAP_n.mp3' }` to `tracks`.
4. Stop after **3 consecutive misses** (allows temporary gaps without ending the scan too early; still cheap).
5. Cap scan at a high upper bound (e.g. `n <= 200`) as a safety stop.
6. If zero tracks found, show a simple message in the playlist area (file:// or empty folder) instead of a broken player.

## UI changes

- Remove or leave empty the subtitle/tag line that currently shows genre-style `tag` text.
- `#trackCount` continues to show `${tracks.length} Tracks` after the scan completes.
- Playlist render runs after the scan finishes; then load track 0 (do not autoplay unless current behavior already does — keep current: load without autoplay on init).

## Constraints / notes

- Browser cannot list a directory; sequential naming is the contract for “automatic”.
- Opening `index.html` via `file://` often cannot fetch local mp3s; a local static server (or GitHub Pages) is required for the scan. Document this briefly in a code comment near the scanner.
- Large mp3s must not be downloaded during the scan — use HEAD or abort GET after headers.

## Out of scope

- Renaming files to non-`LAP_n` patterns.
- Backend / build pipeline.
- Pushing to GitHub (user will request separately).
- Changing visual design beyond tag removal / empty tag line.

## Success criteria

- With current `Lap-set/`, playlist shows 13 items titled `LAP_1` … `LAP_13` in order.
- Adding `LAP_14.mp3` and reloading adds a 14th row without code edits.
- Removing a middle file leaves a gap; scan continues past up to 2 consecutive misses and still finds later numbers; 3 consecutive misses ends the scan.
