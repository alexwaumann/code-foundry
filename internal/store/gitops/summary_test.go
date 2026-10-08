package gitops

import "testing"

func TestFailureSummary(t *testing.T) {
	tests := []struct{ name, out, want string }{
		{"rejected push", "To /tmp/origin.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/tmp/origin.git'\nhint: Updates were rejected\n", "[rejected] main -> main (fetch first)"},
		{"fatal wins over hint", "hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.\n", "Not possible to fast-forward, aborting."},
		{"error line", "error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.\n", "cannot pull with rebase: You have unstaged changes."},
		{"gh last line", "Warning: 1 uncommitted change\nno pull requests found for branch \"x\"\n", "no pull requests found for branch \"x\""},
		{"skips trailing hints", "something broke\nhint: try again\n", "something broke"},
		{"carriage returns", "Counting objects: 50%\rCounting objects: 100%\rfatal: unable to access\n", "unable to access"},
		{"empty", "", "failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := failureSummary(tt.out); got != tt.want {
				t.Errorf("failureSummary = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFetchSummary(t *testing.T) {
	tests := []struct{ name, out, want string }{
		{"nothing", "", "already up to date"},
		{"one update", "From /tmp/origin\n   1a2b3c4..5d6e7f8  main       -> origin/main\n", "fetched 1 updated ref"},
		{"new and updated", "From x\n * [new branch]      feat -> origin/feat\n   1..2  main -> origin/main\n", "fetched 2 updated refs"},
		{"pruned only", "From x\n - [deleted]         (none)     -> origin/gone\n", "pruned 1 ref"},
		{"both", "From x\n - [deleted]  (none) -> origin/gone\n * [new tag] v1 -> v1\n", "fetched 1 updated ref, pruned 1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := fetchSummary(tt.out); got != tt.want {
				t.Errorf("fetchSummary = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPullSummary(t *testing.T) {
	tests := []struct {
		name   string
		out    string
		rebase bool
		want   string
	}{
		{"up to date", "Already up to date.\n", false, "already up to date"},
		{"rebase up to date", "Current branch main is up to date.\n", true, "already up to date"},
		{"fast-forward", "Updating 1..2\nFast-forward\n a.txt | 1 +\n 1 file changed, 1 insertion(+)\n", false, "fast-forwarded: 1 file changed, 1 insertion(+)"},
		{"rebased", "Successfully rebased and updated refs/heads/main.\n", true, "rebased onto upstream"},
		{"rebased with stat", " 2 files changed, 3 deletions(-)\nSuccessfully rebased and updated refs/heads/main.\n", true, "rebased: 2 files changed, 3 deletions(-)"},
		{"unknown", "", false, "pulled"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pullSummary(tt.out, tt.rebase); got != tt.want {
				t.Errorf("pullSummary = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPushSummary(t *testing.T) {
	tests := []struct{ name, out, want string }{
		{"up to date", "Everything up-to-date\n", "already up to date"},
		{"new branch", "To /tmp/o.git\n * [new branch]      feat -> feat\nbranch 'feat' set up to track 'origin/feat'.\n", "pushed feat to origin (new branch)"},
		{"forced", "To /tmp/o.git\n + 1a...2b feat -> feat (forced update)\n", "force-pushed feat to origin"},
		{"plain", "To /tmp/o.git\n   1a..2b  feat -> feat\n", "pushed feat to origin"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pushSummary(tt.out, "feat", "origin"); got != tt.want {
				t.Errorf("pushSummary = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFindPRURL(t *testing.T) {
	tests := []struct{ out, url, num string }{
		{"https://github.com/o/r/pull/12\n", "https://github.com/o/r/pull/12", "12"},
		{"a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/7\n", "https://github.com/o/r/pull/7", "7"},
		{"Creating pull request for x into main in o/r\n\nhttps://github.com/o/r/pull/3\n", "https://github.com/o/r/pull/3", "3"},
		{"no url here", "", ""},
	}
	for _, tt := range tests {
		u, n := findPRURL(tt.out)
		if u != tt.url || n != tt.num {
			t.Errorf("findPRURL(%q) = %q, %q; want %q, %q", tt.out, u, n, tt.url, tt.num)
		}
	}
}
