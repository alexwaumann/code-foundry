# Ember's flame, redrawn (2026-10-21)

Alex reported the flame looked small and never moved. Two causes, one PR, frontend only
(`components/ember/Flame.tsx`, `ember.css`).

## Why it was small

The sketch's paths covered 12.8 of the 24-unit viewBox width and 19.6 of 26 in height, so
the 22×25 row box painted a flame of roughly 12×19 px, and the 44×50 hero about 23×38.
The new drawing fills its viewBox (`0 -2 32 36`, the margin above for the sparks) and the
boxes grew: row 28×32 (in the 50px row), header 18×20, nav 14×16 (lucide's 14), hero 64×72.

## Why it never moved

Alex's Mac has Reduce Motion on, and `ember.css` honoured `prefers-reduced-motion` by
stilling everything. Decision: that setting is for interaction animations, which a
mascot's idle motion is not, so the flame ignores it. There is no reduced-motion block
any more, on purpose; do not add one back.

## The drawing (sketch option C)

Sketched as static HTML (three options, A: the old glyph cropped, B: a chubby body with
blush, C: B with eyebrows) and shown animated in chat; Alex chose C. A chubby flame with
a vertical gradient (yellow tip, orange, hot base) and a cream core, big eyes with
catch-lights, two eyebrows and a mouth. The colours are the mascot's own, as CSS variables
on `.cf-flame` (the palette guard allows `--cf-flame-` lines in `ember.css`; the gradient
stops take theirs through `stop-color`, since a `<stop>` attribute would be a literal in
TypeScript).

By state:

* idle: a slow wobble, the glow dimmed, the pupils drifting to a few spots over 9 s, a smile.
* thinking: taller and faster, the pupils up and to the right, the left brow raised, a small "o".
* working: a flicker, the brows pulled in, the pupils down at the work, a flat concentrating
  mouth, three sparks rising from the tip on staggered delays.
* attention: a bounce, the eyes widened once, both brows up, an open grin (a filled path), and
  the amber ring in `var(--warning)` as before.

Every state blinks every 5.2 s. Hovering winks the right eye and tilts the flame 6°; in the
attention state the bounce owns the svg's transform, so only the wink shows there.

The mouth is a per-state element (a `MOUTH` table in `Flame.tsx`), not a CSS `d:`
animation, as the old grin was. Transforms on SVG children use `transform-box: fill-box`
(brows, eyes, sparks) so percentage origins are the element's own; the body tongues use
`view-box` with the origin at the base so they wobble from the bottom.

## Not changed

`flameState` and every consumer (the row, the chat header, the hero, the settings nav, the
e2e `data-flame` checks) are untouched; the test ids and the state labels are the same.
No design-guard, palette or e2e test needed an edit beyond the palette allowlist already
in place.

## Screenshots

In the PR body (served from the `cf/ember-flame-c-shots` branch; mock app, WebKit): the row
working and needing input in dark and light, the hover wink, the chat header in both
schemes. They are stills; the motion is the point, so look at it in the app.
