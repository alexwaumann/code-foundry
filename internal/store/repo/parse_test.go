package repo

import (
	"errors"
	"reflect"
	"testing"
)

// Fixtures below were captured from git 2.52 (see docs/notes/phase1b-repo.md).

func TestParseStatusV2(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    statusInfo
		wantErr bool
	}{
		{
			name: "upstream ahead behind, modified, staged+modified, rename, untracked with space",
			in: "# branch.oid 1b5ad6fb7b0a3b684215e00490fb2f493b2a3619\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +1 -1\x00" +
				"1 .M N... 100644 100644 100644 61780798228d17af2d34fce4cfbdf35556832472 61780798228d17af2d34fce4cfbdf35556832472 b.txt\x00" +
				"1 MM N... 100644 100644 100644 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 1fdc4576931be191c010563db2254cb04d5bacf3 c.txt\x00" +
				"2 R. N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 R100 renamed.txt\x00a.txt\x00" +
				"? un tracked.txt\x00",
			want: statusInfo{
				Head: "1b5ad6fb7b0a3b684215e00490fb2f493b2a3619", Branch: "main", Upstream: "origin/main",
				Ahead: 1, Behind: 1, Staged: 2, Modified: 2, Untracked: 1,
			},
		},
		{
			name: "clean linked worktree without upstream",
			in:   "# branch.oid 1b5ad6fb7b0a3b684215e00490fb2f493b2a3619\x00# branch.head feat/x\x00",
			want: statusInfo{Head: "1b5ad6fb7b0a3b684215e00490fb2f493b2a3619", Branch: "feat/x"},
		},
		{
			name: "detached",
			in:   "# branch.oid dfbdec4e4e6de539002e25b1f603be64c949732a\x00# branch.head (detached)\x00",
			want: statusInfo{Head: "dfbdec4e4e6de539002e25b1f603be64c949732a", Detached: true},
		},
		{
			name: "merge conflict",
			in: "# branch.oid b42cf5bc10dc74c2d123765be86641da4b3dbea6\x00# branch.head main\x00" +
				"u UU N... 100644 100644 100644 100644 1f25f40627bf553f1a29d49c498ddb66075eaefa 351be5bf6e17c59ea560546d69654115ecb2fd8d e45c9c2666d44e0327c1f9c239a74c508336053e f\x00",
			want: statusInfo{Head: "b42cf5bc10dc74c2d123765be86641da4b3dbea6", Branch: "main", Conflicted: 1},
		},
		{
			name: "unborn branch",
			in:   "# branch.oid (initial)\x00# branch.head main\x00",
			want: statusInfo{Branch: "main"},
		},
		{
			name: "upstream gone (no branch.ab line)",
			in:   "# branch.oid abc\x00# branch.head x\x00# branch.upstream origin/x\x00",
			want: statusInfo{Head: "abc", Branch: "x", Upstream: "origin/x"},
		},
		{
			name: "rename whose original path looks like an entry is skipped",
			in:   "# branch.head m\x002 R. N... 100644 100644 100644 a a R100 new\x00? old\x00",
			want: statusInfo{Branch: "m", Staged: 1},
		},
		{name: "empty", in: "", want: statusInfo{}},
		{name: "bad ab", in: "# branch.ab +x -1\x00", wantErr: true},
		{name: "unknown entry", in: "Z what\x00", wantErr: true},
		{name: "short entry", in: "1 M\x00", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseStatusV2([]byte(tt.in))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("got  %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestParseWorktreeList(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []listedWorktree
		wantErr bool
	}{
		{
			name: "main, detached, nested branch",
			in: "worktree /private/tmp/cf1b-cap/r\x00HEAD 1b5ad6fb7b0a3b684215e00490fb2f493b2a3619\x00branch refs/heads/main\x00\x00" +
				"worktree /private/tmp/cf1b-cap/wt-d\x00HEAD dfbdec4e4e6de539002e25b1f603be64c949732a\x00detached\x00\x00" +
				"worktree /private/tmp/cf1b-cap/wt-x\x00HEAD 1b5ad6fb7b0a3b684215e00490fb2f493b2a3619\x00branch refs/heads/feat/x\x00\x00",
			want: []listedWorktree{
				{Path: "/private/tmp/cf1b-cap/r", Head: "1b5ad6fb7b0a3b684215e00490fb2f493b2a3619", Branch: "main"},
				{Path: "/private/tmp/cf1b-cap/wt-d", Head: "dfbdec4e4e6de539002e25b1f603be64c949732a", Detached: true},
				{Path: "/private/tmp/cf1b-cap/wt-x", Head: "1b5ad6fb7b0a3b684215e00490fb2f493b2a3619", Branch: "feat/x"},
			},
		},
		{
			name: "bare, locked with reason, prunable, path with spaces",
			in: "worktree /r.git\x00bare\x00\x00" +
				"worktree /a b\x00HEAD 00\x00branch refs/heads/x\x00locked on usb\x00\x00" +
				"worktree /gone\x00HEAD 11\x00branch refs/heads/y\x00prunable gitdir file points to non-existent location\x00\x00",
			want: []listedWorktree{
				{Path: "/r.git", Bare: true},
				{Path: "/a b", Head: "00", Branch: "x", Locked: true},
				{Path: "/gone", Head: "11", Branch: "y", Prunable: true},
			},
		},
		{name: "empty", in: "", want: nil},
		{name: "attribute before worktree", in: "HEAD 00\x00", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseWorktreeList([]byte(tt.in))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got  %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestParseLeftRightCount(t *testing.T) {
	tests := []struct {
		in          string
		left, right int
		wantErr     bool
	}{
		{"1\t1\n", 1, 1, false},
		{"0\t12\n", 0, 12, false},
		{"7\t0", 7, 0, false},
		{"", 0, 0, true},
		{"3\n", 0, 0, true},
		{"a\tb\n", 0, 0, true},
	}
	for _, tt := range tests {
		l, r, err := parseLeftRightCount([]byte(tt.in))
		if (err != nil) != tt.wantErr || l != tt.left || r != tt.right {
			t.Errorf("parseLeftRightCount(%q) = %d, %d, %v", tt.in, l, r, err)
		}
	}
}

func TestParseGitHubSlug(t *testing.T) {
	tests := []struct{ in, want string }{
		{"git@github.com:awaumann/code-foundry.git", "awaumann/code-foundry"},
		{"git@github.com:awaumann/code-foundry", "awaumann/code-foundry"},
		{"github.com:owner/name.git", "owner/name"},
		{"ssh://git@github.com/owner/name.git", "owner/name"},
		{"ssh://git@ssh.github.com:443/owner/name.git", "owner/name"},
		{"git+ssh://git@github.com/owner/name.git", "owner/name"},
		{"https://github.com/owner/name.git", "owner/name"},
		{"https://github.com/owner/name", "owner/name"},
		{"https://github.com/owner/name/", "owner/name"},
		{"https://x-access-token:abc@github.com/owner/name.git", "owner/name"},
		{"https://GitHub.com/Owner/Name.git\n", "Owner/Name"},
		{"http://www.github.com/owner/name", "owner/name"},
		{"git://github.com/owner/name.git", "owner/name"},
		{"https://gitlab.com/owner/name.git", ""},
		{"git@gitlab.com:owner/name.git", ""},
		{"git@github-work:owner/name.git", ""}, // ssh host alias: unknown host, not guessed
		{"https://github.com/owner", ""},
		{"https://github.com/owner/name/extra", ""},
		{"/private/tmp/bare", ""},
		{"../bare.git", ""},
		{"file:///tmp/github.com/owner/name", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := parseGitHubSlug(tt.in); got != tt.want {
			t.Errorf("parseGitHubSlug(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestParseOriginHead(t *testing.T) {
	for in, want := range map[string]string{
		"refs/remotes/origin/main\n":  "main",
		"refs/remotes/origin/develop": "develop",
		"refs/remotes/origin/rel/1.x": "rel/1.x",
	} {
		if got := parseOriginHead([]byte(in)); got != want {
			t.Errorf("parseOriginHead(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMainWorktreeFromCommonDir(t *testing.T) {
	tests := []struct {
		in, want string
		wantErr  bool
	}{
		{"/private/tmp/cf1b-cap/r/.git\n", "/private/tmp/cf1b-cap/r", false},
		{"/Users/a/code/x/.git", "/Users/a/code/x", false},
		{"/Users/a/code/x.git", "", true}, // bare
		{".git", "", true},                // relative: --path-format=absolute unsupported
		{"", "", true},
	}
	for _, tt := range tests {
		got, err := mainWorktreeFromCommonDir(tt.in)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("mainWorktreeFromCommonDir(%q) = %q, %v", tt.in, got, err)
		}
		if err != nil && !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("err %v is not ErrInvalidArgument", err)
		}
	}
}

func TestDefaultWorktreePathAndID(t *testing.T) {
	tests := []struct{ main, branch, want string }{
		{"/Users/a/code/foundry", "feat", "/Users/a/code/foundry.worktrees/feat"},
		{"/Users/a/code/foundry", "alex/fix-x", "/Users/a/code/foundry.worktrees/alex-fix-x"},
		{"/r", "a/b/c", "/r.worktrees/a-b-c"},
	}
	for _, tt := range tests {
		if got := defaultWorktreePath(tt.main, tt.branch); got != tt.want {
			t.Errorf("defaultWorktreePath(%q, %q) = %q, want %q", tt.main, tt.branch, got, tt.want)
		}
	}
	id := repoID("/Users/a/code/foundry")
	if len(id) != idLen || id != repoID("/Users/a/code/foundry") || id == repoID("/Users/a/code/other") {
		t.Fatalf("repoID not stable/distinct: %q", id)
	}
}
