package thread

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseNaming(t *testing.T) {
	tests := []struct {
		name       string
		out        string
		withBranch bool
		want       Naming
	}{
		{"labelled lines", "Title: Fix the login redirect\nBranch: fix/login-redirect\n", true,
			Naming{"Fix the login redirect", "fix/login-redirect"}},
		{"markdown around the labels", "Sure!\n\n**Title:** \"Add a search filter\"\n- **Branch**: `feat/search-filter`\n", true,
			Naming{"Add a search filter", "feat/search-filter"}},
		{"JSON object in a fence", "```json\n{\"title\": \"Fix login\", \"branch\": \"fix/login\"}\n```", true,
			Naming{"Fix login", "fix/login"}},
		{"name label and = sign", "name = Bump Go\nbranch = build/bump-go", true, Naming{"Bump Go", "build/bump-go"}},
		{"branch missing", "Title: Fix the login redirect", true, Naming{Title: "Fix the login redirect"}},
		{"title missing: made from the branch", "Branch: feat/add-search-filter", true,
			Naming{"Add search filter", "feat/add-search-filter"}},
		{"no labels: a bare title", "Fix the login redirect.", true, Naming{Title: "Fix the login redirect"}},
		{"first label wins", "Title: One\nTitle: Two\nBranch: fix/one\nBranch: fix/two", true, Naming{"One", "fix/one"}},
		{"junk", "  \n```\n```\n", true, Naming{}},
		{"title only call reads a bare title", "Title: Fix it\nBranch: fix/it", false, Naming{Title: "Fix it"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseNaming(tt.out, tt.withBranch); got != tt.want {
				t.Errorf("parseNaming(%q) = %+v, want %+v", tt.out, got, tt.want)
			}
		})
	}
}

func TestComposeBranch(t *testing.T) {
	semantic := BranchNaming{Mode: BranchModeSemantic, Prefix: "cf"}
	prefix := BranchNaming{Mode: BranchModePrefix, Prefix: "cf"}
	custom := BranchNaming{Mode: BranchModeCustom, Instructions: "x"}
	tests := []struct {
		name               string
		cfg                BranchNaming
		hint, reply, title string
		want               string
	}{
		{"semantic", semantic, "", "feat/add-search-filter", "", "feat/add-search-filter"},
		{"semantic: each listed type", semantic, "", "perf/x", "", "perf/x"},
		{"semantic: type case is folded", semantic, "", "FIX/Login Redirect", "", "fix/login-redirect"},
		{"semantic: unknown type is chore", semantic, "", "feature/x", "", "chore/x"},
		{"semantic: no type is chore", semantic, "", "add-search-filter", "", "chore/add-search-filter"},
		{"semantic: no branch slugs the title", semantic, "", "", "Fix the login redirect", "chore/fix-the-login-redirect"},
		{"semantic: hint wins over the model's slug", semantic, "add-filter", "fix/other", "", "fix/add-filter"},
		{"semantic: hint with a bare type", semantic, "add-filter", "docs", "", "docs/add-filter"},
		{"semantic: hint without a reply", semantic, "add-filter", "", "", "chore/add-filter"},
		{"semantic: slug capped", semantic, "", "feat/" + strings.Repeat("abcdefghij-", 8), "", "feat/abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij"},
		{"semantic: nothing", semantic, "", "", "", ""},
		{"prefix", prefix, "", "add-search-filter", "", "cf/add-search-filter"},
		{"prefix: a slash in the reply is slugged", prefix, "", "feat/add-filter", "", "cf/feat-add-filter"},
		{"prefix: empty prefix is a bare slug", BranchNaming{Mode: BranchModePrefix}, "", "add-filter", "", "add-filter"},
		{"prefix: nested prefix", BranchNaming{Mode: BranchModePrefix, Prefix: "alex/wip/"}, "", "x", "", "alex/wip/x"},
		{"prefix: hint", prefix, "add-filter", "", "", "cf/add-filter"},
		{"prefix: the title", prefix, "", "", "My Big Feature!", "cf/my-big-feature"},
		{"custom: verbatim with spaces made dashes", custom, "", " ab/T-1  do x ", "", "ab/T-1-do-x"},
		{"custom: no reply, hint", custom, "add-filter", "", "", "cf/add-filter"},
		{"custom: nothing", custom, "", "", "Title", ""},
		{"unknown mode is semantic", BranchNaming{Mode: "nope"}, "", "fix/x", "", "fix/x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := composeBranch(tt.cfg, tt.hint, tt.reply, tt.title); got != tt.want {
				t.Errorf("composeBranch = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBranchTypesAreValidated(t *testing.T) {
	for _, typ := range BranchTypes {
		if got := composeBranch(BranchNaming{}, "", typ+"/x", ""); got != typ+"/x" {
			t.Errorf("%s: %q", typ, got)
		}
	}
	for _, typ := range []string{"feature", "bugfix", "hotfix", "style", "", "wip"} {
		if got := composeBranch(BranchNaming{}, "", typ+"/x", ""); got != "chore/x" {
			t.Errorf("%q: %q", typ, got)
		}
	}
}

func TestOffBranch(t *testing.T) {
	tests := []struct {
		name, mode, hint, threadName, want string
	}{
		{"prefix with a name", BranchModePrefix, "", "My Feature", "cf/my-feature"},
		{"prefix without a name", BranchModePrefix, "", "", ""},
		{"prefix with a hint", BranchModePrefix, "add-filter", "My Feature", "cf/add-filter"},
		{"semantic with a name", BranchModeSemantic, "", "My Feature", ""},
		{"semantic with a hint", BranchModeSemantic, "add-filter", "", "chore/add-filter"},
		{"custom with a name", BranchModeCustom, "", "My Feature", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bc := branchChoice{cfg: BranchNaming{Mode: tt.mode, Prefix: "cf"}, hint: tt.hint}
			if got := offBranch(bc, tt.threadName); got != tt.want {
				t.Errorf("offBranch = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNewBranchChoice(t *testing.T) {
	tests := []struct {
		flag, wantVerbatim, wantHint string
		wantErr                      error
	}{
		{flag: ""},
		{flag: " alex/JIRA-12 ", wantVerbatim: "alex/JIRA-12"},
		{flag: "Add Filter!", wantHint: "add-filter"},
		{flag: "!!!", wantErr: ErrInvalidArgument},
		{flag: "-x/y", wantErr: ErrInvalidArgument},
		{flag: "a b/c", wantErr: ErrInvalidArgument},
	}
	m := &Manager{opts: Options{BranchNaming: DefaultBranchNaming}}
	for _, tt := range tests {
		t.Run(tt.flag, func(t *testing.T) {
			bc, err := m.newBranchChoice(tt.flag)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err == nil && (bc.verbatim != tt.wantVerbatim || bc.hint != tt.wantHint || bc.cfg != DefaultBranchNaming()) {
				t.Errorf("choice = %+v", bc)
			}
		})
	}
}

func TestBranchRequest(t *testing.T) {
	tests := []struct {
		name string
		bc   branchChoice
		want *BranchRequest
	}{
		{"semantic", branchChoice{cfg: BranchNaming{Mode: BranchModeSemantic}}, &BranchRequest{Mode: BranchModeSemantic}},
		{"semantic hint", branchChoice{cfg: BranchNaming{Mode: BranchModeSemantic}, hint: "x"}, &BranchRequest{Mode: BranchModeSemantic, Hint: "x"}},
		{"custom", branchChoice{cfg: BranchNaming{Mode: BranchModeCustom, Instructions: "i"}, hint: "x"},
			&BranchRequest{Mode: BranchModeCustom, Instructions: "i", Hint: "x"}},
		{"prefix", branchChoice{cfg: BranchNaming{Mode: BranchModePrefix}}, &BranchRequest{Mode: BranchModePrefix}},
		{"prefix hint needs no model", branchChoice{cfg: BranchNaming{Mode: BranchModePrefix}, hint: "x"}, nil},
		{"verbatim needs no model", branchChoice{cfg: BranchNaming{Mode: BranchModeSemantic}, verbatim: "a/b"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.bc.branchRequest()
			if (got == nil) != (tt.want == nil) || (got != nil && *got != *tt.want) {
				t.Errorf("branchRequest = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestBuildNamingPrompt(t *testing.T) {
	tests := []struct {
		name   string
		req    NamingRequest
		want   []string
		absent []string
	}{
		{"title only", NamingRequest{Message: "fix it"}, []string{namingPrompt + "fix it"}, []string{"Branch:"}},
		{"semantic", NamingRequest{Message: "fix it", Branch: &BranchRequest{Mode: BranchModeSemantic}},
			[]string{"Title: <title>\nBranch: <branch>", "feat, fix, chore, docs, ci, refactor, test, perf, build", "Request:\nfix it"},
			[]string{"named this task"}},
		{"semantic hint", NamingRequest{Message: "fix it", Branch: &BranchRequest{Mode: BranchModeSemantic, Hint: "add-filter"}},
			[]string{"<type>/add-filter", "choose only the type"}, nil},
		{"prefix", NamingRequest{Message: "fix it", Branch: &BranchRequest{Mode: BranchModePrefix}},
			[]string{"Branch: a slug of"}, []string{"<type>"}},
		{"custom with name and hint", NamingRequest{Message: "fix it", Name: "Login work", Branch: &BranchRequest{Mode: BranchModeCustom, Instructions: "ab/<ticket>", Hint: "login"}},
			[]string{"these instructions:\nab/<ticket>\n", "slug login", "The user named this task: Login work"}, nil},
		{"no message: the name is the request", NamingRequest{Name: "Login work", Branch: &BranchRequest{Mode: BranchModeSemantic}},
			[]string{"Request:\nLogin work"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildNamingPrompt(tt.req)
			for _, w := range tt.want {
				if !strings.Contains(got, w) {
					t.Errorf("prompt misses %q:\n%s", w, got)
				}
			}
			for _, w := range tt.absent {
				if strings.Contains(got, w) {
					t.Errorf("prompt has %q:\n%s", w, got)
				}
			}
		})
	}
}

func TestValidBranch(t *testing.T) {
	for b, want := range map[string]bool{"ab/T-1-do-x": true, "fix/x": true, "ab/..x": false, "a~b": false, "-x": false, "a b": false, "x.lock": false} {
		if got := validBranch(context.Background(), b); got != want {
			t.Errorf("validBranch(%q) = %v, want %v", b, got, want)
		}
	}
}
