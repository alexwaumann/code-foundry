# GitHub PR links open in the side panel

PR A of the pull request panel redesign. A plain click on a GitHub pull request link in a
thread's messages, or in a pull request's description and comments, opens it as a Pull
request tab in the side panel. Cmd+click, ctrl+click and middle click open the browser.
Every other link still opens the browser, and there is no setting for it.

## Decisions

- `lib/prUrl.ts` `parsePullRequestUrl` is the one parser:
  `http(s)://(www.)github.com/<owner>/<repo>/pull/<n>`, optionally followed by `/files`,
  `/commits`, `/checks` or `/changes`, a trailing slash, a query, or a fragment. The host
  is matched in any case. Owners and names must pass the same rules as `lib/githubRef`.
  Issues, commits, compare views, other hosts, ports, credentials, leading zeros and
  numbers past 10 digits all return null. The slug keeps the case it was written in, as
  every other `openPullRequestInPanel` caller passes it.
- The routing is opt-in: `MarkdownExtras.openLink(url) => boolean`. The `Markdown` link
  calls it only for a plain click (main button, no cmd or ctrl). If it returns false, the
  browser opens the link (`openUrl`) as before. It handles a middle click (`auxclick`
  button 1) only when `openLink` is set. Plugin `MarkdownNode`, `MarkdownPreview` and
  `HelpOverlay` don't set it, so they behave exactly as before, middle click included.
- `components/pr/prLinks.ts` provides two things:
  - `openPullRequestLink(target)`: parse the URL, then `openPullRequestInPanel(ref, target)`.
    That returns false when nothing is selected, and the click then falls back to the browser.
  - `usePanelMarkdownExtras()` for the PR surface: the target is the panel key from
    `PanelKeyContext`, so the tab opens in the panel that holds the surface. A split
    group's pointer-down already makes it the focused group, so the new tab lands in the
    group that was clicked, with no group argument needed.
- Thread messages use `threadExtras` (every `ThreadMarkdown` and `StreamingMarkdown`), with
  target `"current"`. Relative links in a thread are still file chips: `link` runs before
  `openLink`. In a PR body, a relative `/owner/repo/pull/N` resolves against github.com
  first (`resolveLink`), so it opens in the panel too.
- "Not in tool output": raw tool output renders as plain text (`ToolDetail` `Output`), so
  it has no links. A subagent's handed-back report and a compaction summary are model
  markdown through `ThreadMarkdown`, and they route like messages.
- The tooltip didn't change. It still shows the URL, which isn't visible on screen.

## Verification

- vitest: `lib/prUrl.test.ts` (table) and `components/pr/prLinks.test.tsx`. The second
  covers: a plain click opens the panel with the right ref and target; cmd, ctrl and
  middle clicks open the browser; with no panel, the browser opens; a non-PR link opens
  the browser; a PR body link goes to the panel key from its context, relative links
  included; `Markdown` without `openLink` is unchanged.
- No e2e test: nothing here needs a real browser.
- GUI against the mock (WebKit): `POST /__mock/thread/stream?text=…` put PR links into
  s-r1's answer.
  - A plain click opened `#145` in the panel with no `view.open.url`.
  - Cmd+click and an issue link each sent one `view.open.url`.
  - A link injected into #145's description (through `__cfModule` on `stores/gh.ts`)
    opened `#138` as a second tab of the same panel.
