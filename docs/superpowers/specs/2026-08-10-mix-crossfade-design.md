# Mix (crossfade) design

Date: 2026-08-10  
Status: approved in chat (approach 1 — dual `<audio>` + volume ramp)

## Goal

Optional **Mix** toggle so consecutive tracks overlap: current fades out while the next fades in for a configurable duration.

## Requirements

- Toggle button next to shuffle; icon = circle with two crossing lines (user reference).
- Label/title: **Mix**. Active state matches shuffle (`active` / `aria-pressed`).
- Duration slider **only when Mix is on**: 2–12 seconds, default **6s**, live label (`6s`).
- Mix applies **only** on automatic advance (end of track / impending end). Next/prev/playlist click stay hard cut.
- No persistence: page load → Mix off, duration 6s.
- Master volume / mute apply during mix (both decks scaled to master).

## Approach

Two `<audio>` elements (active + incoming). Near `duration - mixDuration`, start next track on the incoming element at volume 0, ramp active → 0 and incoming → master over the mix window, then swap roles.

Short tracks: clamp effective mix to ~40% of duration (minimum sensible overlap); if too short for a useful mix, fall back to hard transition via `ended`.

## Out of scope

- Web Audio API / DSP
- Mix on manual skip
- Persisting Mix settings
- Beatmatching / tempo sync
