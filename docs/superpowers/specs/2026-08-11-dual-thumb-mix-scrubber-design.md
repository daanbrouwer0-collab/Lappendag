# Dual-thumb mix scrubber

Date: 2026-08-11  
Status: approved in chat

## Goal

Replace the mix scrubber handoff animation (interpolated single thumb + opacity fades) with a stable dual-thumb display during crossfade. Fix mobile stutter/jumps. Show two balls when two tracks play at once.

## Requirements

1. Remove mix scrubber crossfade/ease (no interpolating one thumb from outgoing → incoming position).
2. During mix: show **two** thumbs — outgoing at old track %, incoming at new track %.
3. During mix: **no scrubbing** (range disabled / non-interactive).
4. Outside mix: keep single thumb + fill + scrubbing as today.
5. Audio volume crossfade unchanged.

## Non-goals

- Scrubbing either deck during mix.
- Redesigning the rest of the player.
- Changing mix duration / analysis.

## UI

- Normal: one fill (lime) + native range thumb.
- Mixing:
  - Hide or ignore native range thumb (opacity 0 / pointer-events none / disabled).
  - Two CSS thumbs positioned with `left` from percent (same thumb-size mapping as today).
  - Two fills: outgoing + incoming (existing lanes OK; drop opacity pulse animation).
  - Outgoing = current color; incoming = pink accent.
- Mix end: remove outgoing thumb/fill; single thumb resumes at incoming position; re-enable scrubbing.

## Implementation notes

- Drive positions from `audio.currentTime` / `audioIncoming.currentTime` each mix rAF frame — no `scrubT` blend.
- Cancel mix / loadTrack: restore single-thumb UI.
- Mobile: avoid layout thrash (transform/left on thumbs only; no opacity keyframe handoff).

## Testing

1. Desktop local: mix shows two balls moving independently; no jump at handoff.
2. Mobile / slow network: no stuttery scrubber fade; balls may lag with buffer but must not interpolate-jump.
3. After mix: one ball, scrubbing works.
4. Scrub during normal play still works; during mix scrub input ignored.
