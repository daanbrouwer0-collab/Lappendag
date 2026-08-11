# Now-playing download button

Date: 2026-08-11  
Status: approved in chat

## Goal

Let the user download the currently loaded/playing track from a button next to the My list (+) control in the now-playing title row.

## Requirements

1. Download control only in the now-playing title row (not in the playlist).
2. Place it beside the existing + / − My list button.
3. Visible only when a track is actually loaded on the active deck (same visibility gate as the My list button).
4. On click, download that track’s MP3 with filename `Lap_N.mp3` (from the track title / file basename).
5. Use native download (`<a download>` or equivalent programmatic click) — no extra prefetch; fetch only happens when the user clicks.

## Non-goals

- Per-row download in the playlist.
- Fetch-to-blob / forced cross-origin download pipeline.
- Changing lazy-load or mix behavior.

## UI

- Button styled like `.list-toggle-btn` / `.now-playing-list-btn`.
- Icon: Font Awesome `fa-download`.
- `title` / `aria-label`: e.g. `Download Lap_N`.

## Behavior

- Wire in `index.html` + `app.js` (`updateNowPlayingListBtn` or a sibling `updateNowPlayingDownloadBtn`).
- `href` / download target = `tracks[currentIndex].file`; `download` attribute = basename (e.g. `Lap_12.mp3`).
- Idle (“Druk play”) / no `src`: button hidden.

## Testing

1. Cold load: no download button.
2. After Play: button appears next to +.
3. Click downloads the playing file with a sensible filename.
4. Track change updates the download target.
