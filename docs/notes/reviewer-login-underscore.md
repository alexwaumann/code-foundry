# Reviewer logins with underscores

A user on a GitHub Enterprise with managed users could not request a reviewer: the
daemon answered `invalid argument: login "WMD270_cof"` before sending anything.

## Cause

`reviewerLoginRE` in `internal/store/gh/pr_actions.go` encoded the github.com username
rule (alphanumerics and hyphens). Enterprise managed users (EMU) get an `_shortcode`
suffix on every login, so every colleague on such an enterprise was rejected. The
reviewer search has no such guard, which is why the picker listed them and only the
request failed. The pattern came in with the first reviewer-request commit and had no
test for rejected logins.

## Fix

- Underscores are allowed after the first character in `reviewerLoginRE`.
- `prOwner` in `internal/store/thread/subscriptions_pr.go` had the same hyphen-only rule
  for the owner part of `owner/name#123` and pull request URLs; EMU organisations can
  carry the suffix too, so it takes underscores as well.
- Table tests pin both: an EMU login, a bot login, a plain login, and rejected shapes
  (leading hyphen, space, dot, 40 characters).

Team slugs already accepted underscores and are unchanged.
