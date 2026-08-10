# Netlify loader speed, progressive audio, mobile fit

Date: 2026-08-11  
Status: approved in chat (approach 1)

## Goal

Keep Netlify as a thin loader that serves the site from GitHub via jsDelivr. Make first paint and first playable track fast, show clear loading state while background work continues, and keep the player fully visible on mobile.

## Requirements

1. **Host model:** Netlify shell (`index_voor netlify.html`) stays; real assets remain on GitHub / jsDelivr (not full Netlify deploy of `Lap-set/`).
2. **Fast shell load:** Do not block first page load on the GitHub commits API.
3. **Progressive audio:** First track (`Lap_1`) becomes playable as soon as the player UI is ready; full playlist scan continues in the background.
4. **Visible loading:** User can see that something is still loading (shell and/or tracks) so waiting is understandable.
5. **Mobile fit:** On phones the player must stay within the viewport (no controls cut off / falling off-screen). Rave visual language stays; only scale/spacing changes on small screens.

## Non-goals

- Deploying all MP3s to Netlify.
- Maintaining a hand-edited `tracks.json` manifest (rejected approach 2).
- Full visual redesign.
- Autoplay without user gesture (browser policy unchanged).

## Architecture

### A. Netlify loader (`index_voor netlify.html`)

1. On open, resolve CDN base immediately:
   - Prefer last known commit SHA from `localStorage` if present.
   - Else use `@main`.
2. Fetch and show `index.html` in the iframe without waiting for GitHub API.
3. In parallel / after first show: fetch latest commit SHA from GitHub API, cache in `localStorage`, optionally soft-refresh only if SHA changed and user has not started audio (or on next visit).
4. Show a simple full-viewport loading overlay (“Site laden…”) until iframe content is ready; then hide it.
5. Keep hash-based navigation / `srcdoc` + `<base>` rewrite behavior unless a smaller fix is required for correctness.

### B. Progressive track discovery (`app.js`)

1. **Immediate bootstrap:** Assume `Lap-set/Lap_1.mp3` exists; set `tracks = [Lap_1]`, bind controls, load deck A with that file, enable play.
2. **Background scan:** Continue probing `Lap_2`… with the existing miss-limit / max-cap rules, but:
   - Prefer concurrent probes (small batch, e.g. 4–8 in flight) instead of one-at-a-time.
   - Append newly found tracks to `tracks` and re-render playlist incrementally.
3. **Status copy:**
   - While scanning: e.g. “Tracks laden… (N gevonden)” in a muted status area / track subtitle / playlist header count.
   - When done: normal “N Tracks” (or equivalent).
4. Play/pause/next/prev work against the tracks known so far; shuffle/next only among discovered tracks until scan completes.
5. If `Lap_1` HEAD/load fails, fall back to waiting for the first successful probe before enabling play, and show a clear empty/error state if none found.

### C. Mobile layout (`styles.css`, minor HTML only if needed)

1. Below ~600px:
   - Reduce `.glass-panel` / `.player-card` padding and vertical gaps.
   - Shrink disc / visualizer block.
   - Tighten control row spacing; keep ~44px tap targets.
2. Use `100dvh` (with `100vh` fallback) for shell iframe and page height so mobile browser chrome does not push content off-screen.
3. Allow the page/main column to scroll within the viewport rather than overflowing horizontally or clipping the player.
4. Verify location modal and corner controls still usable on small widths.

## Data flow

```
Netlify shell
  → immediate jsDelivr fetch (cached SHA or @main)
  → overlay until iframe ready
  → background: refresh SHA cache

iframe site (app.js)
  → bootstrap Lap_1 → play enabled
  → parallel background scan → playlist grows + status updates
```

## Error handling

- GitHub API failure: ignore; keep `@main` / cached SHA.
- jsDelivr / page fetch failure: show existing-style error in the shell.
- Zero tracks after scan: existing empty playlist message.
- Mid-scan network blips: treat as miss per probe; do not disable an already-playing deck.

## Testing

- Cold load on Netlify: overlay appears briefly, site shows without waiting on API.
- Play pressed as soon as UI is interactive: audio starts on `Lap_1` while playlist still filling.
- Status text updates during scan and settles when finished.
- iPhone-width (~390px) and small Android (~360px): player controls visible without horizontal overflow; vertical scroll acceptable for playlist.
- Desktop layout unchanged at ≥900px two-column grid.

## Success criteria

- First interactive play no longer waits for full 150+ sequential HEAD probes.
- Loading is visually indicated for shell and for incomplete track scan.
- On mobile widths, the player fits / scrolls inside the screen instead of falling outside.
- New sequential `Lap_n.mp3` files still appear after reload without a manifest file.
