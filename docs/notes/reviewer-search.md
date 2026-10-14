# Reviewer picker: GitHub search and recent reviewers

The add-reviewer picker listed `assignableUsers(first: 100)` and filtered it in cmdk, so in
a large org anyone past the first 100 could not be found. It now asks GitHub.

## Decisions

* **Server-side search.** `ListReviewerCandidatesRequest.query` (new field 3) feeds
  `assignableUsers(first: 20, query: $query) @include(if: $search)`; `search` is
  `query != ""` after trimming, so an empty query costs only the `reviewRequests` part.
  The pending requests always come back. `truncated` is gone from the response (field 2
  and the name reserved): with a search there is no "first 100" to report.
* **Decoder order.** Requested first, then search results, each by login; the author is
  left out, and a requested user the search also returned appears once, marked
  requested. The store's dedupe key includes the trimmed query.
* **Picker.** Below 2 trimmed characters it shows two groups: *Requested* (the empty-query
  read; selecting withdraws) and *Recent* (this repository's recently requested people,
  minus anyone requested); both empty says "Type 2+ characters to search". From 2
  characters it searches after a 250 ms pause (`components/pr/reviewerSearch.ts`), cmdk
  has `shouldFilter={false}`, and a spinner sits in the input while the term waits or
  loads. Teams are not searchable (`assignableUsers` is users only); requested teams
  still show under Requested.
* **Requested rows among results.** The response lists every pending request whatever the
  query, so in search mode the picker keeps a requested row only when its login or name
  contains the term; the other results are exactly what GitHub returned.
* **Stale searches are aborted.** `createResource` gained `abortOnRelease`: when the last
  watcher of a key lets go (the term moved on), its fetch is aborted and the entry stops
  loading. Only `reviewerCandidatesResource` opts in.
* **Busy spinner.** The resource is keyed `slug#number\0query`. `setReviewRequest`
  invalidates every key of the pull request and waits until none of them is loading, so
  whichever key the open picker watches settles the spinner.
* **Recents** (`stores/reviewerRecents.ts`): localStorage `code-foundry.reviewerRecents`,
  per lowercased repo slug, newest first, 8 at most, `{login, name, avatarUrl, kind}`.
  Added (moved to front) only when the picker's request succeeds, not on withdraw and not
  from the palette or CLI (they have no avatar or name). The row's × (`aria-label`
  "Remove from recent", no tooltip) removes it.

## Gotchas

* cmdk selects a row on click, so the × stops propagation and prevents default on both
  pointerdown and click. It has `tabIndex={-1}` so focus stays in the input and arrow-key
  navigation is unchanged; there is no keyboard path to remove a recent.
* `useReviewerSearchTerm` never sets state synchronously in its effect (react-hooks
  lint): under the threshold it reports `""` directly and keeps the last term in state.
  Typing back to a term searched earlier shows it straight away from the cache. The
  flip side: after clearing the input, a new search shows the previous term's results
  (with the spinner) for the 250 ms pause.
* The ghostty#13779 capture predates the search (`first: 100` with `totalCount`); its
  nodes have the shape a search returns, so the decoder tests still use it.
* The mock daemon (`mock/prDetail.ts`) adds 120 org members (`ada-abbott` …
  `zoe-zimmerman`), matches by substring of login or name, returns at most 20, and counts
  searches as `ListReviewerCandidates query` in `/__mock/gh/calls`.

## Verification

`make check` and `make gui-e2e` (pr-panel.spec.ts: no search under 2 characters, a
member past the first 100 found, "No one matches.", a request lands in Recent once
withdrawn, Recent survives reopening, × removes without requesting).
