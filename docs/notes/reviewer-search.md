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
* `useReviewerSearchTerm` resets its term during render once the input drops under the
  threshold (the derived-state pattern; a synchronous setState in the effect trips the
  react-hooks lint). Without it, a new search after clearing the input showed the
  previous term's results for the 250 ms pause.
* The ghostty#13779 capture predates the search (`first: 100` with `totalCount`); its
  nodes have the shape a search returns, so the decoder tests still use it.
* The mock daemon (`mock/prDetail.ts`) adds 120 org members (`ada-abbott` …
  `zoe-zimmerman`), matches by substring of login or name, returns at most 20, and counts
  searches as `ListReviewerCandidates query` in `/__mock/gh/calls`.

## Verification

`make check` and `make gui-e2e` (pr-panel.spec.ts: no search under 2 characters, a
member past the first 100 found, "No one matches.", a request lands in Recent once
withdrawn, Recent survives reopening, × removes without requesting).

# Word search and confirmed requests

Two bugs a user hit: searching "first last" found nobody while "last, first" worked,
and choosing a result looked like it failed to add the person.

## Causes

* `assignableUsers(query:)` matches the whole string against the login and the stored
  profile name. Names stored as "Doe, Jane" match "doe, jane" but never "jane doe".
* The picker kept a requested row among the results only when the whole term was a
  substring of its login or name. A person found through a looser match lost their row
  the moment the re-read listed them as requested.
* The REST POST to `requested_reviewers` answers 201 even when GitHub does not add the
  reviewer (someone without access to the repository). Nothing checked the
  `requested_reviewers` it returned, so the click reported success and the row came
  back unchecked.

## Decisions

* **Words.** The trimmed term splits on whitespace and commas; empty pieces are dropped
  and at most 4 are kept (`reviewerSearchTokens`, mirrored by `reviewerSearchTokens` in
  `components/pr/reviewerSearch.ts`). One word: exactly the old query and order.
* **Still one request.** The document is static: four extra aliased fields
  `t0..t3: assignableUsers(first: 20, query: $qN) @include(if: $sN)` beside the
  whole-string field. Every variable is always sent (`sN` false, `qN` ""), so
  `TestDetailQueryVariables` still holds and an empty or one-word search costs what it
  did. A query of several words costs up to five 20-node lists in one paced call.
* **Filter and order** (`reviewer_search.go`). The lists merge by login (first seen
  wins, requested users and the author excluded as before). A user stays when every
  word, folded (lowercase, letters and digits only), is in the folded login or the
  folded name. Order: a word is a login prefix, then every word starts a name word,
  then the rest; ties by login, case-insensitive. Words with no letter or digit
  ("-") are ignored. Requested users still come first and are not filtered (the picker
  filters them).
* **Confirmed requests.** `SetReviewRequest` checks GitHub's response: after a request
  the login (or the team's slug, against `requested_teams`) must be listed, after a
  withdraw it must be gone; case-insensitive. Otherwise `ErrFailedPrecondition`: "GitHub
  did not add <login> as a reviewer (they may lack access to the repository)" or "GitHub
  still lists <login> as a requested reviewer". The detail is not invalidated then
  (nothing changed). Bots (`[bot]` logins) are not checked: GitHub lists
  copilot-pull-request-reviewer[bot] as Copilot.
* **Picker rows.** `matches()` uses `matchesReviewerSearch` (every word in the login or
  name, same folding). `prPanel.confirmed` holds what a successful pr.review.request
  from the picker left, keyed like `requesting`: the row shows the check (or its
  absence) as soon as the command returns, instead of the spinner during the re-read,
  and keeps it if the re-read lags GitHub. Closing the picker clears it
  (`clearConfirmedRequests`), so the next open shows GitHub's state. Lists are deduped
  by kind and login before rendering.
* **Bold token highlighting** from the mockup was skipped: it would split the login and
  name spans for little gain.

## Gotchas

* GitHub's REST answer is the only confirmation: the GraphQL re-read right after the
  write may not list the request yet, which is why the picker trusts `confirmed` over
  the re-read while it stays open.
* The mock (`mock/prDetail.ts`) adds jdoe ("Doe, Jane"), zdoe ("Doerr, Janelle") and
  outside-olga ("Outside, Olga") to #145. Requesting outside-olga fails with the
  daemon's precondition text, so the "Request Review failed" toast is testable.
* The mock imports `reviewerSearchTokens` and `matchesReviewerSearch` from `src`; the
  module also imports React, which tsx loads without trouble.

## Verification

* Go: `reviewer_search_test.go` (tokens, rank, filter order, variables),
  `TestDecodeReviewerCandidatesTokens` on `testdata/reviewer_candidates_tokens_synthetic.json`
  ("jane doe", "doe, jane", "Doe,Jane": the same list), the shapes table (one word
  unfiltered, a login-only hit), `TestReviewerCandidatesSeveralWords` through the
  worker and the fake GitHub (one request per search), and `TestSetReviewRequestREST`
  (not added, team not added, case-insensitive hit, bot skipped, withdraw not applied).
* GUI: `reviewerSearch.test.ts` (tokens, matching), `prPanel.test.ts` (confirmed during
  and after a lagging re-read, cleared on close, absent after a failure), and the e2e
  test in `pr-panel.spec.ts` ("doe, jane" and "jane doe" list jdoe then zdoe; the click
  keeps jdoe checked; outside-olga toasts "Request Review failed" with the reason).
* `make check` and `make gui-e2e`.
