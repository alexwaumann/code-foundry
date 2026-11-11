# Visible fixes: usage colours, durations, segmented control, plugin bits

Seven small changes a user can see, one commit each.

## Usage chart colours by family

- `lib/usage.ts` colours by family (`modelFamily`: opus, fable/mythos, sonnet, haiku,
  matched anywhere in the id so Bedrock's `us.anthropic.claude-…` ids count). The four
  fixed ids are gone, so the defaults (Sonnet 5, Sonnet 4.6, Opus 4.8) are no longer
  grey "Other".
- Every model is its own series (`seriesOf` is the id without a snapshot suffix, so
  `[1m]`, `@…` and a `-YYYYMMDD` date fold into their model). Series order: family, then
  newest version first (`compareModels`), Other last.
- Shades are per chart (`modelColors(series)`): a family's newest model gets the hue,
  each older one is mixed toward white by `1 - 0.62^i` (0.38, 0.62, 0.76…), so no two
  series in one chart share a colour. The colours live in `UsagePageData.colors` and are
  passed to the chart and the model table, so a table swatch matches its bar.
- The mock fixture now has two opus and two sonnet models and a `<synthetic>` bucket for
  Other. The unpriced model became `claude-opus-4-1`; `claude-opus-5-6` would have taken
  the hue from Opus 5.5 as the "newest" model.

## base_from_origin wording

The behaviour stays: a branch only origin has is still fetched when it is checked out,
because the checkout cannot work otherwise. The setting, the flag help, the proto
comments, `types.go`/`startpoint.go`, `placement.go` and ARCHITECTURE.md now say that
new branches are not fetched from origin and that checking out an origin-only branch
still fetches it. `projecttest.Fake.CreateWorktree` fetches `origin/<branch>` when
`SetRefs` lists the branch under Remote and no local ref or worktree has it, whatever
BaseFromOrigin says, as the real store does.

## One duration, one age, one clock

`lib/duration.ts`:

- `formatDuration(ms, { days, hours, minutes, seconds, tenths })` gives the largest
  chosen unit it reaches, then the next chosen unit unless that part is zero. It is
  unpadded and rounded down: "12s", "4m 8s", "4m", "1h 5m", "3d 2h". Under the smallest
  chosen unit it is "0s" or "0m". `tenths` gives "4.2s" under 10 s.
- `formatAge(at, now, { seconds … years, ago })` uses one unit: "4m ago", "just now".
  Weeks and months take over from two of them ("13d ago", then "2w ago"), which matches
  the PR tables. `ago: false` gives a table cell's "4m" and "now".
- `formatClock(ms)`: "0:04", "1:02:03". It replaces dictation's `formatElapsed` and
  actions' `formatRunClock`, and the plugin countdown uses it.

How the callers changed:

- Ticking timers keep seconds: agent and shell elapsed, turn and step headers, Ember's
  live row.
- The sidebar row keeps "4s / 4m / 1h 4m / 3d" through `statusTimeUnits` in
  `lib/statusRegistry.ts`, which picks the units by range. `lib/elapsed.ts` is gone; its
  `elapsedTickMs` had no caller.
- Finished steps go through `toolSummary.tookText`, which is "" under 50 ms, as before.
  Action runs and git ops go through `RUN_DURATION` (tenths under 10 s).
- What changes on screen:
  - "1m 03s" is now "1m 3s".
  - "4 min ago", "2 h ago" and "3 d ago" are now "4m ago", "2h ago" and "3d ago":
    thread notes, the update dialog, plugin secrets, MCP, catalog and skill reads, and
    memory under an hour.
  - The API retry note says "retrying in 20s".
  - An archived row under a minute reads "now" (it was "0m").
  - Ember's "Worked for" shows seconds ("2m 5s").
  - Plugin durations drop a zero part ("4m", not "4m 0s").
- Left alone because they are not the same kind of formatter: `promptHistory.relativeAge`
  and `memory.rememberedWhen` past an hour (calendar words: yesterday, dates), plugin
  `formatRelative` (it also does future times), and `ember.clockTime`/`format.sentTime`
  (wall-clock times).

## Themes gallery

`MiniSidebar` copies `SidebarRow` as it is now:

- Three lines: the pin and the name with the status icon on the right (the word is
  sr-only, as in the real row), the project after its kind glyph (Layers for a
  workspace) with the counts on the right, then the branch.
- Section headers sit at the bottom of a 26px band.
- A snoozed row is one quiet line with the alarm countdown after the name.

The statuses come from `statusRegistry`, so the icons and tones follow the real row. The
"worktree" chip is gone from the chips sample. The dialog sample is `rounded-pane` inside
a `rounded-2xl` frame, so the inner corner is one step under its padded parent's.

## Plugin header buttons

`SurfaceHeader` draws an action icon-only only when it has an icon. Without one it is the
ordinary small labelled `PluginButton`. Before, it was an empty 24px button.

## Plugin flood throttle

`countLocked` records the last flooding second. A view that comes a minute
(`floodQuiet`) after that second lifts the throttle. `viewUpdate` then clears the
"<surface> flood" issue and writes a host log line. The check runs when the next view
arrives, not on a timer: a surface that floods and then goes silent keeps the issue
until its next view. The store has no fake timers, and a silent surface shows nothing
the throttle would hold back anyway.

## Segmented control

`components/usage/Segmented.tsx` is gone. Its four callers use `RadioGroup
variant="segmented" size="sm"`: one tab stop, arrow keys, `aria-checked`.

- `size="sm"` is new: a `rounded-md p-0.5` group with `rounded-sm px-2 py-0.5
  text-caption-sm` segments. A context hands the size to `RadioGroupChoice`.
- The look moves from Segmented's bordered strip to the radio group's filled one (muted
  track, raised selected segment).
- Test ids are unchanged (`<id>-<value>`); tests read `aria-checked`.
- The search dialog's mouse-down guard still keeps focus in the field.
