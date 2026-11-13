# Testing gotchas (vitest, jsdom, React Testing Library)

What trips up a component test in `gui/frontend`, by library. Each one has a test that
works around it today; the file named is a place to copy from.

## jsdom

- No layout: every size is 0. Fake the geometry with a `getBoundingClientRect` spy
  (`plugin/layout.test.tsx`) or mock `@/lib/useWidth` (`diff/DiffView.test.tsx`).
- No `scrollIntoView` or `scrollTo`: stub them on `Element.prototype` (cmdk scrolls its
  highlighted row into view; `compose/ProjectPicker.test.tsx`, `settings/SettingsPage.test.tsx`).
- No `ResizeObserver` (`src/test/setup.ts` stubs it for Radix form controls), no pointer
  capture (`panel/SidePanel.split.test.tsx`), and nothing ever intersects, so an
  `IntersectionObserver` is faked (`files/FileTab.test.tsx`).
- An image never fires `load`: set `naturalWidth`/`naturalHeight` and fire `load` yourself
  (`files/FileTab.test.tsx`). pdf.js does not run (no canvas): tests say what a PDF is.
- ProseMirror's `scrollIntoView` asks for range rects: stub `Range.prototype.getBoundingClientRect`
  (`compose/hostFiles.test.tsx`).
- The real composer editor runs: `fireEvent.keyDown` on `composer-input` reaches its key
  handler, but typing does not; edit through the editor on the node
  (`composer-input`'s `.editor.commands`, `compose/ComposerSend.test.tsx`). Tag node views
  render a tick later.
- @pierre/diffs renders only its sprite: assert the `diffs-container` element, leave the
  lines to e2e (`thread/PendingPrompt.test.tsx`).
- Enter or Space on a button is not a click, and `fireEvent.doubleClick` fires no clicks
  before the dblclick. `blur` only reaches a focused element: focus it first.
- Code that waits a frame (`requestAnimationFrame`) needs the frame: queue and flush the
  callbacks (`thread/PendingPrompt.test.tsx`) or await one inside `act`
  (`addproject/AddProjectDialog.test.tsx`).

## React Testing Library

- `render` comes wrapped in a `TooltipProvider` (`src/test/setup.ts`); Radix tooltips throw
  without one.

## Radix

- A dropdown menu opens on `fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })`,
  a context menu on `fireEvent.contextMenu`. A picked item runs in `onCloseAutoFocus`, so wait
  a tick after the click (`actions/CheckoutActions.test.tsx` `settle`).
- Popovers open on click but render a tick later: `findByTestId`, not `getByTestId`.
- Roving focus (radio tiles, toolbars) moves on a timer: wait a `setTimeout(0)` after each
  key (`actions/ActionDialog.test.tsx`).
- A tooltip opens on focus reached by a navigation key (`tooltipText` in `src/test/tooltip.ts`)
  only on a focusable trigger; a span needs a pointer move and the open delay
  (`hoverTooltipText`).
- A tooltip left open on a trigger focused by a key is a dismissable layer: the next Escape
  closes it, not the popover. Open such a popover with pointerdown then click.

## TanStack Virtual

- It sizes from `offsetWidth`/`offsetHeight`, which are 0, so it renders no rows. Mock
  `useVirtualizer` with a stand-in that lays every row out at its estimated size
  (`search/SearchDialog.test.tsx`, `sidebar/Sidebar.test.tsx`), or stub `offsetHeight` on
  `HTMLElement.prototype`.

## dnd-kit

- After a drag, its click swallower stays on the document for 50 ms: a click in the next
  test is lost. New describes in `panel/SidePanel.test.tsx` go before "reordering tabs".

## cmdk

- An item picks on click; it scrolls the active row into view (stub `scrollIntoView`).
  Group headings are `[cmdk-group-heading]`.

## vitest

- A `vi.mock` factory that imports a module importing stores deadlocks the file: vitest hangs
  before the first test with no output. Keep fakes store-free (`src/test/daemonFakes.ts`,
  `cardFakes.ts`), and import the component and stores after the mocks with top-level
  `await import(...)` (`actions/ActionDialog.test.tsx`).
- `refreshCommands` runs after every command and replaces the commands store from the fake's
  `daemon.commands`: set both, or command buttons vanish mid-test (`bottom/BottomPanel.test.tsx`).
- Persisted module state outlives a test: reset the panel store (`resetPanels()` in
  `src/test/projectsWorld.ts`), and give a test that leaves per-thread state (a failed
  send's notice) a thread id of its own.
- A debounce under fake timers: `vi.useFakeTimers({ shouldAdvanceTime: true })` and
  `advanceTimersByTimeAsync`, so zero timeouts still run (`pr/PullRequestSurface.test.tsx`).
- sonner's `toast(...)` cannot be spied on: mount a `Toaster`, find the text, and
  `toast.dismiss()` in `afterEach` (`actions/ActionRunDialog.test.tsx`).
- A store fed by a fake stream gets a published snapshot a tick later: wait until the store
  holds it before asserting (`settings/DictationSettings.test.tsx`).
- A test that times out keeps running after vitest moved on: with module-level fakes its late
  steps break the next tests ("Unable to find"). Use `it` from `src/test/isolate.ts` and call
  `trackTests()` before the file's hooks (`pr/PullRequestSurface.test.tsx`).
