package gh

import (
	"slices"
	"strings"
	"testing"
)

func TestDecodeMergeFields(t *testing.T) {
	// Captures from before the merge fields: no methods known, no auto-merge.
	d, _, err := decodeFullPullRequest(fixtureData(t, "pull_request_full_cf_1.json"))
	if err != nil || d.MergeMethods != nil || d.AutoMerge {
		t.Errorf("capture: methods %v, auto-merge %t, %v", d.MergeMethods, d.AutoMerge, err)
	}
	tests := []struct {
		name string
		repo string // repository fields besides pullRequest
		pr   string // pull request fields
		want []MergeMethod
		auto bool
	}{
		{name: "all three", repo: `"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true`,
			want: []MergeMethod{MergeCommit, MergeSquash, MergeRebase}},
		{name: "squash only, auto-merge on", repo: `"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false`,
			pr: `"autoMergeRequest":{"enabledAt":"2026-10-09T10:00:00Z"},`, want: []MergeMethod{MergeSquash}, auto: true},
		{name: "none allowed", repo: `"mergeCommitAllowed":false,"squashMergeAllowed":false,"rebaseMergeAllowed":false`,
			pr: `"autoMergeRequest":null,`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := `{"repository":{"viewerPermission":"WRITE",` + tt.repo + `,"pullRequest":{` + tt.pr + `"number":7,"state":"OPEN"}}}`
			d, _, err := decodeFullPullRequest([]byte(doc))
			if err != nil || !slices.Equal(d.MergeMethods, tt.want) || d.AutoMerge != tt.auto {
				t.Errorf("methods %v, auto-merge %t, %v; want %v, %t", d.MergeMethods, d.AutoMerge, err, tt.want, tt.auto)
			}
		})
	}
}

func TestDecodeMerge(t *testing.T) {
	tests := []struct {
		name, data string
		want       mergeOutcome
		err        string
	}{
		{name: "merged", data: `{"mergePullRequest":{"pullRequest":{"merged":true,"state":"MERGED","mergeCommit":{"oid":"abc"}}}}`,
			want: mergeOutcome{Merged: true, State: PullRequestMerged, SHA: "abc"}},
		{name: "accepted, not merged yet", data: `{"mergePullRequest":{"pullRequest":{"merged":false,"state":"OPEN","mergeCommit":null}}}`,
			want: mergeOutcome{State: PullRequestOpen}},
		{name: "null payload", data: `{"mergePullRequest":null}`, err: "no pull request"},
		{name: "not JSON", data: `{`, err: "decode merge"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decodeMerge([]byte(tt.data))
			if tt.err != "" {
				if err == nil || !strings.Contains(err.Error(), tt.err) {
					t.Errorf("err = %v, want %q", err, tt.err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
		})
	}
}

func TestHeadMoved(t *testing.T) {
	for msg, want := range map[string]bool{
		"Head branch was modified. Review and try the merge again.": true,
		"Expected head sha does not match":                          true,
		"Pull Request is not mergeable":                             false,
	} {
		pe := &PartialError{Errors: []graphQLError{{Type: "UNPROCESSABLE", Message: msg}}}
		if got := headMoved(pe); got != want {
			t.Errorf("headMoved(%q) = %t, want %t", msg, got, want)
		}
	}
}
