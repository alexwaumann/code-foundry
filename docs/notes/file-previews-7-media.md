# File previews 7: video and audio (2026-11-14)

The File tab plays video (mp4 m4v mov webm) and audio (mp3 wav m4a aac ogg flac), streamed
from the daemon's media route (docs/notes/file-previews-2-daemon.md), under a control bar of
our own. Two kinds, `previews/kinds/video.ts` and `audio.ts`; the player is
`previews/media/`.

## Files

| Path | What |
| --- | --- |
| `previews/kinds/video.ts`, `audio.ts` | the kinds: daemon's extensions, `shows: media`, `read: "stream"`, `edit: false`, `editor: false` |
| `previews/MediaBody.tsx` | `VideoBody`, `AudioBody` |
| `previews/media/MediaPlayer.tsx` | the element, its URL's life, keys, full screen, the cannot-play and error states |
| `previews/media/ControlBar.tsx` | play, time, scrubber (buffered underlay), length, speed menu, volume, full screen |
| `previews/media/playerState.ts` | the reducer and `errorOutcome` (pure) |
| `previews/media/playerKeys.ts` | which key is which action, and when a key is not the player's (pure) |
| `previews/media/mediaFormat.ts` | `formatTime`, `mediaMeta`, `mediaTypeName`, `bufferedEnd`, `rateLabel` (pure) |
| `previews/media/useMediaGrant.ts` | StreamFile once per path and version, again on `regrant()` and a new daemon pid |
| `previews/media/useFullscreen.ts` | the Fullscreen API on the player's root |
| `stores/mediaPlayer.ts` | volume, mute, speed; persisted (`code-foundry.mediaPlayer`) |
| `gui/main.go` | `MacWebviewPreferences{FullscreenEnabled}` |
| `mock/mediaPlayer.ts` | `docs/media/broken.webm`, a "video" WebKit cannot decode |
| `e2e/file-previews-media.spec.ts` | plays, clock, seek, release on close, keys vs chords, cannot-play; SHOTS |

Shared lines changed: `types.ts` (`"stream"` in `PreviewRead`, `editor`), `FileTab.tsx`
(`stream: readFile` in `READS`; `editor` to FileActions; the too-large state's Open in editor), `FileHeader.tsx` (`FileActions` `editor`), `ui/slider.tsx` (`thumbClassName`),
`ui/dropdown-menu.tsx` (`container`), `mock/files.ts` (one fixture line), `FileTab.test.tsx`
(a `streamFile` stub and one test), `registry.test.ts` (rows).

## Decisions

- **The read is "stream", and it is ReadFile.** The daemon answers a media file with its facts
  (size, time, `media`) and no bytes, which is all the header needs. The URL is not part of
  the read: it is the element's, asked for by the player (useMediaGrant) and again whenever
  the element needs a new one. It is one more entry in FileTab's `READS` (the logs PR's map:
  `whole`, `tail`), not a branch.
- **No Open in editor for media.** It opens the checkout in a code editor at the file, which
  shows nothing useful for a video. `editor: false` on a kind drops it from the header and the
  too-large state; Open in Finder (and so QuickTime) stays. No Copy contents (no text), no
  wrap, no switch (one mode, no text), no pencil.
- **A URL's life.** `useMediaGrant(baseDir, path, version)` asks StreamFile on mount, when
  the file's size or time changes or Refresh is pressed (`version`), on `regrant()`, and
  when the daemon's pid changes (a restart: its grants died with it), like `usePreviewGrant`.
  Each answer bumps `generation`, and the player loads the element again even when the URL is
  the same string.
- **Error or expired?** WebKit reports the media route's 404 (a grant from before a restart)
  as "source not supported", the same code as a file it cannot decode. `errorOutcome` tells
  them apart by history: a URL that loaded metadata and then failed is asked for again
  (`regrant`); a new URL that fails before its metadata is the file's fault (`unplayable`),
  or the daemon's (`failed`, network error). Aborted loads are ignored, and so is the error a
  release fires (no `src`).
- **Picking up where it was.** Before the element loads a new URL, the player keeps
  `{ at, play }` (from the element when it had metadata, or from the last state on an error);
  on the next `loadedmetadata` it seeks there and plays if it was playing. Checked in the
  Wails window: paused at 0:04, the daemon killed and started again (another pid), Play
  went on from 0:04.
- **One stream per player on screen.** A tab that is not active is unmounted (PaneView), so
  hidden and closed are the same: the player's cleanup pauses, removes `src` and calls
  `load()`, which leaves the element with no source and no connection (`networkState`
  EMPTY; the e2e test checks it on a closed tab). Playing on while the window is in the
  background is allowed: that is listening, not a stream off screen.
- **Two tabs of one file** each have their element, position and state; they share the grant
  (the daemon dedupes it per path) and the remembered volume and speed. Playing one does not
  pause the other.
- **First frame.** `preload="metadata"`. The Wails WKWebView painted a paused video black until
  it decoded a frame (Playwright's WebKit did not), so after the metadata, with no position
  to restore, the player seeks to 0.001 s: one small range read, and the first frame shows.
- **Scrubber.** shadcn Slider over a track of our own (the buffered stretch at the playhead,
  `bufferedEnd`), `step` 0.01. A drag pauses (and plays again after if it was playing), the
  reducer's `scrub` holds the thumb so `timeupdate` never moves it under the pointer, and
  the frame follows with `fastSeek` (video only). Left and Right on the thumb are the
  player's 5 s, not the slider's step (its `onKeyDown` takes them before Radix's own);
  Home and End stay Radix's.
- **Volume inline, not a popover.** The slider opens beside the speaker on hover or when the
  keyboard is in it (Tab from the speaker), and stays open through a drag. Inline because it
  then works in full screen without portalling, and at 420 px the closed bar keeps the
  scrubber long. The speaker click mutes; unmuting at volume 0 comes back at 0.5. Up and Down
  step 0.1; raising the volume above 0 unmutes.
- **Speed menu** is a DropdownMenu (0.5×, 1×, 1.25×, 1.5×, 2×). In full screen nothing
  outside the full-screen element is drawn, so `DropdownMenuContent` takes a `container`
  (the player's root while in full screen). `defaultPlaybackRate` is set too, since a load
  resets `playbackRate` to it.
- **Keys.** The player's root is focusable (a click on the frame focuses it) and marked
  `data-keys-local`, so the window's bare-key commands leave keys inside it alone; chords
  with any modifier are never the player's, so cmd+k, cmd+w and the rest still work (e2e).
  Space on a button presses that button; menus and fields keep their keys.
- **Full screen.** WKWebView refuses the Fullscreen API unless element full screen is on, so
  `gui/main.go` turns it on (`FullscreenEnabled`). Checked in a built app: the button shows,
  the player fills the screen with its bar, plays, and leaves. Where `document.fullscreenEnabled`
  is false the button and F are gone rather than dead. The menu-bar Toggle Full Screen is the
  window's own and unchanged.
- **Audio's visual: an icon and the name**, not a waveform or a level meter. A waveform needs
  the whole file decoded, which defeats streaming. A level meter needs an AnalyserNode on a
  `MediaElementAudioSourceNode`, and the media route sends no CORS headers (by design, so no
  page can read the bytes): a cross-origin element routed through Web Audio outputs silence,
  so the meter would mute the file. The icon brightens while playing.
- **Meta.** Before the metadata the kind's `mediaMeta` says size and type (`3.1 MB · WebM`);
  the body then calls `onMeta` with length and frame (`0:42 · 1440 × 900 · 3.1 MB · WebM`,
  `1:12 · 1.1 MB · MP3`). A stream with no set length shows no length rather than `--:--`.

## Checked end to end

- Mock (`make drive`) in WebKit: clip and tone play; speed, volume, keys; `broken.webm` shows
  the cannot-play state.
- `make drive DAEMON=dev` with generated files outside the repo (no ffmpeg here: a 90 s
  1280×720 H.264 mp4 written with AVAssetWriter, 10.3 MB, `moov` at the end; a 10 min WAV,
  50.5 MB, and its AAC m4a): the mp4 opened at its first frame with `1:30 · 1280 × 720 ·
  10.3 MB · MP4`; seeking the WAV to 9:55 before it had loaded buffered only 595 to 600 s
  and played on (206s in the daemon's request log), so the route's ranges are what the
  element uses.
- `make gui-build`, run on a scratch home, the video opened by a LayoutService open-surface
  op: first frame, full screen in and out, play, and the daemon restart above.

## Gotchas

- jsdom has no media playback: `MediaPlayer.test.tsx` fakes the element's properties on the
  prototype per element (a WeakMap) and makes `play`, `pause` and `load` record and fire
  what a browser would.
- `document.fullscreenEnabled` is read once per player (useState); a test sets it before
  rendering.
- The mock's `/__mock/daemon/restart` keeps its pid and media grants, so a restart's re-grant
  is a vitest test and a manual check, not an e2e one.
