package gh

import (
	"errors"
	"strings"
	"testing"
)

func TestParseRepoRef(t *testing.T) {
	tests := []struct {
		in          string
		owner, name string
		err         string // substring; empty means success
	}{
		{"alexwaumann/code-foundry", "alexwaumann", "code-foundry", ""},
		{"  Octo-Org/Hello.World  ", "Octo-Org", "Hello.World", ""},
		{"owner/repo.git", "owner", "repo", ""},
		{"https://github.com/owner/repo", "owner", "repo", ""},
		{"https://github.com/owner/repo.git", "owner", "repo", ""},
		{"https://github.com/owner/repo/", "owner", "repo", ""},
		{"HTTPS://WWW.GitHub.com/owner/repo", "owner", "repo", ""},
		{"https://github.com/owner/repo/tree/main/docs", "owner", "repo", ""},
		{"https://github.com/owner/repo?tab=readme#top", "owner", "repo", ""},
		{"github.com/owner/repo", "owner", "repo", ""},
		{"", "", "", "no repository given"},
		{"git@github.com:owner/repo.git", "", "", "SSH URLs are not supported"},
		{"ssh://git@github.com/owner/repo", "", "", "SSH URLs are not supported"},
		{"http://github.com/owner/repo", "", "", "only https:// URLs"},
		{"https://gitlab.com/owner/repo", "", "", "not gitlab.com"},
		{"gitlab.com/owner/repo", "", "", "not gitlab.com"},
		{"https://github.com/owner", "", "", "does not name a repository"},
		{"https://github.com/", "", "", "does not name a repository"},
		{"owner", "", "", "is not owner/repo"},
		{"a/b/c", "", "", "is not owner/repo"},
		{"code foundry", "", "", "is not owner/repo"},
		{"my org/repo", "", "", "is not owner/repo"},
		{"-bad/repo", "", "", "not a valid owner/repo"},
		{"owner/..", "", "", "not a valid owner/repo"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			owner, name, err := ParseRepoRef(tt.in)
			if tt.err != "" {
				if err == nil || !strings.Contains(err.Error(), tt.err) || !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("err = %v, want ErrInvalidArgument containing %q", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if owner != tt.owner || name != tt.name {
				t.Fatalf("got %s/%s, want %s/%s", owner, name, tt.owner, tt.name)
			}
		})
	}
}
