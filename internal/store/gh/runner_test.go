package gh

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGraphQLArgs(t *testing.T) {
	got, err := graphQLArgs("query Q { x }", map[string]any{
		"owner": "ghostty-org", "name": "true", "first": 25, "flag": false, "after": nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api", "graphql", "-f", "query=query Q { x }",
		"-F", "first=25", "-F", "flag=false", "-f", "name=true", "-f", "owner=ghostty-org"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("args =\n %q\nwant\n %q", got, want)
	}
	if _, err := graphQLArgs("q", map[string]any{"x": 1.5}); err == nil {
		t.Error("float variable: want error")
	}
}

func TestClassifyFailure(t *testing.T) {
	tests := []struct {
		name   string
		code   int
		stdout string
		stderr string
		want   error
	}{
		// Real gh 2.83.2 output, captured in testdata.
		{"not logged in (exit 4)", 4, "", "stderr_not_logged_in.txt", ErrNotAuthenticated},
		{"bad credentials", 1, "stdout_bad_credentials.json", "stderr_bad_credentials.txt", ErrNotAuthenticated},
		{"repo not found", 1, "", "stderr_repo_not_found.txt", ErrNotFound},
		// gh's messages for failures we cannot trigger on demand.
		{"graphql timeout", 1, "", "=gh: HTTP 502", ErrServerTimeout},
		{"gateway timeout", 1, "", "=gh: HTTP 504", ErrServerTimeout},
		{"secondary rate limit", 1, "",
			"=gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
			ErrRateLimited},
		{"too many requests", 1, "", "=gh: HTTP 429", ErrRateLimited},
		{"primary rate limit", 1, "", "=gh: API rate limit exceeded for user ID 1. (HTTP 403)", ErrRateLimited},
		{"offline", 1, "",
			"=error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
			ErrNetwork},
		{"dns", 1, "", "=Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host",
			ErrNetwork},
	}
	read := func(ref string) []byte {
		switch {
		case ref == "":
			return nil
		case strings.HasPrefix(ref, "="):
			return []byte(ref[1:])
		default:
			return fixture(t, ref)
		}
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := classifyFailure(tt.code, read(tt.stdout), read(tt.stderr))
			if !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
		})
	}

	var rle *RateLimitError
	err := classifyFailure(1, nil, []byte("gh: You have exceeded a secondary rate limit (HTTP 403)"))
	if !errors.As(err, &rle) || !rle.Secondary {
		t.Errorf("secondary: err = %#v", err)
	}
	err = classifyFailure(2, nil, []byte("something odd\nmore"))
	if err == nil || isGlobal(err) || !strings.Contains(err.Error(), "something odd") ||
		strings.Contains(err.Error(), "more") {
		t.Errorf("unknown failure: err = %v", err)
	}
}

func TestParseGraphQLOutput(t *testing.T) {
	tests := []struct {
		name    string
		code    int
		stdout  []byte
		stderr  []byte
		wantErr error
	}{
		{"ok", 0, fixture(t, "viewer.json"), nil, nil},
		// gh exits 1 and prints the body when the response carries errors.
		{"repo not found", 1, fixture(t, "graphql_repo_not_found.json"), fixture(t, "stderr_repo_not_found.txt"), ErrNotFound},
		{"pr not found", 1, fixture(t, "graphql_pr_not_found.json"), nil, ErrNotFound},
		{"rate limited", 1, fixture(t, "graphql_rate_limited_synthetic.json"), nil, ErrRateLimited},
		{"bad credentials body", 1, fixture(t, "stdout_bad_credentials.json"), fixture(t, "stderr_bad_credentials.txt"), ErrNotAuthenticated},
		{"no body", 4, nil, fixture(t, "stderr_not_logged_in.txt"), ErrNotAuthenticated},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := parseGraphQLOutput(tt.code, tt.stdout, tt.stderr)
			if tt.wantErr == nil {
				if err != nil || len(data) == 0 {
					t.Errorf("data=%d bytes err=%v", len(data), err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("err = %v, want %v", err, tt.wantErr)
			}
		})
	}
	if _, err := parseGraphQLOutput(0, []byte("not json"), nil); err == nil {
		t.Error("garbage stdout: want error")
	}
	if _, err := parseGraphQLOutput(0, []byte(`{"data":null}`), nil); err == nil {
		t.Error("null data: want error")
	}
}

func TestParseAuthStatus(t *testing.T) {
	tests := []struct {
		file string
		want AuthStatus
	}{
		{"auth_status_ok.json", AuthStatus{LoggedIn: true, Login: "octocat", TokenSource: "keyring"}},
		{"auth_status_logged_out.json", AuthStatus{Error: "no github.com account"}},
		// GH_TOKEN=bogus: the active account is the env token (invalid); the keyring
		// account is inactive and must not count.
		{"auth_status_bad_token.json", AuthStatus{TokenSource: "GH_TOKEN",
			Error: `non-200 OK status code: 401 Unauthorized body: "{\r\n  \"message\": \"Bad credentials\",\r\n  \"documentation_url\": \"https://docs.github.com/rest\",\r\n  \"status\": \"401\"\r\n}"`}},
	}
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			got, err := parseAuthStatus(fixture(t, tt.file))
			if err != nil {
				t.Fatal(err)
			}
			if got.LoggedIn != tt.want.LoggedIn || got.Login != tt.want.Login || got.TokenSource != tt.want.TokenSource {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
			if !strings.HasPrefix(tt.want.Error, got.Error) || (tt.want.Error == "") != (got.Error == "") {
				t.Errorf("error = %q, want prefix of %q", got.Error, tt.want.Error)
			}
		})
	}
}

// fakeGh writes an executable shell script standing in for gh.
func fakeGh(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExecRunner(t *testing.T) {
	ctx := context.Background()
	viewer, err := filepath.Abs("testdata/viewer.json")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("passes args and env, returns data", func(t *testing.T) {
		argsFile := filepath.Join(t.TempDir(), "args")
		r := ExecRunner{Path: fakeGh(t, `printf '%s\n' "$@" > `+argsFile+`
[ "$GH_PROMPT_DISABLED" = 1 ] || exit 9
cat `+viewer+"\n")}
		data, err := r.GraphQL(ctx, "query { viewer { login } }", map[string]any{"owner": "o"})
		if err != nil {
			t.Fatal(err)
		}
		if v, _, err := decodeViewer(data); err != nil || v.Login != "octocat" {
			t.Errorf("viewer = %+v, %v", v, err)
		}
		args, _ := os.ReadFile(argsFile)
		if want := "api\ngraphql\n-f\nquery=query { viewer { login } }\n-f\nowner=o\n"; string(args) != want {
			t.Errorf("argv = %q, want %q", args, want)
		}
	})

	t.Run("exit 4 is not authenticated", func(t *testing.T) {
		r := ExecRunner{Path: fakeGh(t, "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4\n")}
		if _, err := r.GraphQL(ctx, "q", nil); !errors.Is(err, ErrNotAuthenticated) {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		r := ExecRunner{Path: fakeGh(t, "exec sleep 5\n"), Timeout: 100 * time.Millisecond}
		start := time.Now()
		_, err := r.GraphQL(ctx, "q", nil)
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 3*time.Second {
			t.Errorf("err = %v after %v", err, time.Since(start))
		}
	})

	t.Run("missing binary", func(t *testing.T) {
		r := ExecRunner{Path: filepath.Join(t.TempDir(), "nope")}
		if _, err := r.GraphQL(ctx, "q", nil); err == nil || isGlobal(err) {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("auth status", func(t *testing.T) {
		ok, _ := filepath.Abs("testdata/auth_status_ok.json")
		r := ExecRunner{Path: fakeGh(t, `[ "$1 $2 $3 $4" = "auth status --json hosts" ] || exit 9
cat `+ok+"\n")}
		st, err := r.AuthStatus(ctx)
		if err != nil || !st.LoggedIn || st.Login != "octocat" {
			t.Errorf("status = %+v, %v", st, err)
		}
	})
}
