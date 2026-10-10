# Start page and backdrop

Decided 2026-10-10 (Alex), from the approved "glow" sketch (a static HTML mock with
onboarding, projects and composer states).

## What changed

* **Nothing selected shows the start page** (`components/start/StartPage.tsx`), centred in
  the content pane both ways with the composer's `m-auto` column-flex trick (it falls back
  to scrolling from the top when the pane is too short). The old `mt-[18vh]` offset was
  window-relative and is gone.
  * **Onboarding** (repos loaded and zero projects): logo tile, "Welcome to Code Foundry",
    Add a project (`repo.register`, the palette asks for a path), Command palette, and
    three frosted step cards.
  * **Fleet** (any project): a time-of-day greeting (computed per render from the local
    clock; it does not tick), `N connected · N running · N waiting on you` (connected =
    state not disconnected, running = busy and not disconnected, waiting =
    `attentionIds`; the waiting segment is amber only when non-zero), New thread
    (`session.new`), Command palette, the waiting then running threads (six rows, then
    `+N more`; hidden when empty), and a bare "Keyboard Shortcuts" link (`view.help`).
  * Before the repos snapshot lands the fleet state shows, so a returning user never sees
    onboarding flash.
* **Removed from this page:** the "New terminal" button (the `terminal.new` command and
  every other entry point stay), the project count, and the "A new thread starts by…"
  sentence.
* **`SessionLink`** moved to `components/session/SessionLink.tsx` with optional `icon`
  and `detail`; the worktree overview keeps the status icon and badge label. A start page
  row is a status dot plus `waiting · <project>` / `running · <project>`; the project is
  the repo `placeSession` finds for the thread's worktree, omitted if it cannot be placed.
* **Composer:** same backdrop; the card surface is `bg-card/85 backdrop-blur-xl`. The
  member chips were left as they are (they read fine over the image).

## Backdrop

* Setting **`appearance.backdrop`**: enum `forest` (default) | `none`, live. The daemon
  owns the schema (`internal/store/settings/schema.go`, `Settings.Appearance.Backdrop`);
  the mock daemon's copy is in `gui/frontend/mock/settings.ts`. A new value needs only
  an entry in the schema enum and in `ART` in `components/backdrop/Backdrop.tsx`.
* Treatment (the sketch's `.v-glow`): `mask-image: radial-gradient(55% 45% at 50% 50%,
  #000 0%, rgba(0,0,0,.6) 40%, transparent 100%)`, opacity .38 dark / .22 light (light
  also desaturates to .85), `cover`, positioned `center 40%`. CSS lives in
  `components/backdrop/backdrop.css`.
* **Aspect switching is pure CSS:** the layer is `container-type: size` (it is
  `absolute inset-0`, so it has a definite size) and `@container (aspect-ratio > 1.45)`
  swaps the 16:9 cut in for the 4:3 one. The art is a `background-image` from a custom
  property, so only the cut in use is fetched (two `<img>`s with `display: none` would
  both download).
* **Images:** the user's 2400x1792 / 2752x1536 JPEGs (about 2.7 MB each) re-encoded with
  `cwebp -q 80 -resize 2048 0` to `src/assets/backdrop/forest-{4-3,16-9}.webp`, 160 KB and
  130 KB. Originals are not committed. Imported through Vite, so they are hashed into
  `dist/` and embedded in the binary.
* **Logo tile:** `src/assets/logo.webp` (8 KB) is `gui/build/appicon.png` cropped to the
  squircle (its transparent 100 px margin removed) and scaled to 128 px.
* **Layout:** the backdrop sits in a `relative` wrapper beside the scrolling section (not
  inside it), so it stays put when the content scrolls; the section is `relative` so it
  paints above the absolutely positioned layer.

## Gotchas

* **`backdrop-filter` makes a stacking context.** On the composer's card surface (an
  `aria-hidden` sibling sharing grid cells with the prompt and toolbar) it painted over
  the non-positioned toolbar, hiding the model / effort / permission labels. The card
  grid is now `isolate` and the surface `-z-10`, which keeps it under its siblings
  without dropping it behind the backdrop.
* The mock's s-1 flips busy/idle every 4 s and s-5/s-6 settle after 8 s; e2e that counts
  threads disconnects those first. New mock controls: `POST /__mock/empty` (no projects,
  threads or terminals) and `POST /__mock/threads?repo=&count=&status=&prefix=`.
* The setting is in the daemon's schema, so a running daemon must be restarted before the
  settings page lists it. The GUI treats a missing value as `forest`.
