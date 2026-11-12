package scripts

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// sweepGh stands in for gh: it appends each call's arguments to $FAKE_DIR/calls, answers
// the reads from the environment (already filtered: the script's --jq is not run), and
// keeps the body file of an issue write as $FAKE_DIR/body.
const sweepGh = `#!/bin/bash
printf '%s\n' "$*" >>"$FAKE_DIR/calls"
case "$1 $2" in
"auth token") echo token ;;
"issue list") printf '%s' "$FAKE_ISSUE" ;;
"api "*)
	case "$2" in
	*/jobs\?*) printf '%s' "$FAKE_JOBS" ;;
	*/runs\?*) printf '%s' "$FAKE_GREEN" ;;
	*/compare/*)
		if [ -n "$FAKE_COMPARE_FAILS" ]; then echo '{"message":"Not Found"}'; exit 1; fi
		printf '%s' "$FAKE_MERGED" ;;
	esac ;;
"issue create" | "issue comment")
	for ((i = 1; i <= $#; i++)); do
		if [ "${!i}" = --body-file ]; then j=$((i + 1)); cp "${!j}" "$FAKE_DIR/body"; fi
	done ;;
esac
`

// A failed go-test job's log as the API serves it: runner timestamps, a vitest line with
// colour codes, noise, and a repeated line.
const jobLog = "2026-11-09T03:40:09.5937510Z === RUN   TestSurfaceActs\n" +
	"2026-11-09T03:40:09.5937510Z --- FAIL: TestSurfaceActs (1.27s)\n" +
	"2026-11-09T03:40:09.5937511Z     --- FAIL: TestSurfaceActs/sub (0.10s)\n" +
	"2026-11-09T03:40:09.5989000Z FAIL\tgithub.com/alexwaumann/code-foundry/internal/store/plugin\t179.940s\n" +
	"2026-11-09T03:40:09.5989000Z FAIL\tgithub.com/alexwaumann/code-foundry/internal/store/plugin\t179.940s\n" +
	"2026-11-09T03:40:10.0000000Z ok  \tgithub.com/alexwaumann/code-foundry/internal/theme\t0.4s\n" +
	"2026-11-09T03:35:01.3694465Z \x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/a.test.tsx\x1b[2m > \x1b[22mposts the theme\n" +
	"2026-11-09T03:35:01.3903107Z ##[error]AssertionError: expected 3, got 4\n" +
	"2026-11-09T03:45:10.9441290Z ##[error]Process completed with exit code 2.\n"

func TestSweepReport(t *testing.T) {
	script, err := filepath.Abs("sweep-report.sh")
	if err != nil {
		t.Fatal(err)
	}
	logs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/o/r/actions/jobs/7/logs" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(jobLog))
	}))
	defer logs.Close()

	const green, red = "go-test=success go-lint=success frontend=success", "go-test=failure go-lint=success frontend=success"
	tests := []struct {
		name      string
		results   string
		issue     string
		env       []string
		wantCalls []string // each must be the start of one recorded call
		noCalls   []string // none may be the start of a recorded call
		wantBody  []string
		noBody    []string
	}{
		{
			name: "green with no issue open writes nothing", results: green,
			noCalls: []string{"issue create", "issue comment", "issue close", "label create"},
		},
		{
			name: "green closes the open issue", results: green, issue: "12",
			wantCalls: []string{"issue close 12 --repo o/r --comment Green again at 012345678 ([sweep](https://github.com/o/r/actions/runs/99))."},
			noCalls:   []string{"issue create", "issue comment"},
		},
		{
			name: "red with no issue open opens one", results: red,
			env:       []string{"FAKE_JOBS=7 go-test\n", "FAKE_GREEN=aaaaaaaaabbbbbbbbb\n", "FAKE_MERGED=- #654 (`cf/a`)\n- #655 (`cf/b`)\n"},
			wantCalls: []string{"label create main-red", "issue create --repo o/r --title main is red --label main-red --body-file"},
			noCalls:   []string{"issue comment", "issue close"},
			wantBody: []string{
				"The sweep on main failed at 012345678: [run 99](https://github.com/o/r/actions/runs/99).",
				"| go-test | failure |\n| go-lint | success |",
				"**go-test**\n\n```\n--- FAIL: TestSurfaceActs (1.27s)\n    --- FAIL: TestSurfaceActs/sub (0.10s)\nFAIL\tgithub.com/alexwaumann/code-foundry/internal/store/plugin\t179.940s\n FAIL  src/a.test.tsx > posts the theme\n##[error]AssertionError: expected 3, got 4\n```",
				"Merged since the last green sweep (aaaaaaaaa):\n\n- #654 (`cf/a`)\n- #655 (`cf/b`)",
				"`gh run rerun 99 --failed`",
			},
			noBody: []string{"2026-11-09T", "\x1b[", "Process completed", "=== RUN", "ok  \t"},
		},
		{
			name: "red while the issue is open comments on it", results: red, issue: "12",
			env:       []string{"FAKE_JOBS=7 go-test\n", "FAKE_GREEN=aaaaaaaaabbbbbbbbb\n"},
			wantCalls: []string{"issue comment 12 --repo o/r --body-file"},
			noCalls:   []string{"issue create", "issue close", "label create"},
			wantBody:  []string{"No pull request merged since the last green sweep (aaaaaaaaa)."},
		},
		{
			name: "a cancelled job is red, and a job with no failing line says so", results: "go-test=cancelled go-lint=success frontend=success",
			env:       []string{"FAKE_JOBS=8 go-test\n"},
			wantCalls: []string{"issue create"},
			wantBody:  []string{"| go-test | cancelled |", "**go-test**\n\nNo failing test found in its log"},
			noBody:    []string{"last green sweep"},
		},
		{
			name: "an API error never reaches the report", results: red,
			env:       []string{"FAKE_GREEN=aaaaaaaaabbbbbbbbb\n", "FAKE_COMPARE_FAILS=1"},
			wantCalls: []string{"issue create"},
			wantBody:  []string{"The last green sweep was aaaaaaaaa; the pull requests merged since could not be listed."},
			noBody:    []string{"Not Found"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(sweepGh), 0o755); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("/bin/bash", script)
			cmd.Env = append([]string{
				"PATH=" + dir + ":/usr/bin:/bin",
				"FAKE_DIR=" + dir, "FAKE_ISSUE=" + tt.issue,
				"RESULTS=" + tt.results,
				"GITHUB_REPOSITORY=o/r", "GITHUB_SHA=0123456789abcdef", "GITHUB_RUN_ID=99", "GITHUB_RUN_ATTEMPT=1",
				"GITHUB_API_URL=" + logs.URL, "GH_TOKEN=token",
			}, tt.env...)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("sweep-report.sh: %v\n%s", err, out)
			}
			calls, _ := os.ReadFile(filepath.Join(dir, "calls"))
			lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
			has := func(prefix string) bool {
				for _, l := range lines {
					if strings.HasPrefix(l, prefix) {
						return true
					}
				}
				return false
			}
			for _, w := range tt.wantCalls {
				if !has(w) {
					t.Errorf("no gh call starting %q in:\n%s", w, calls)
				}
			}
			for _, n := range tt.noCalls {
				if has(n) {
					t.Errorf("a gh call starting %q in:\n%s", n, calls)
				}
			}
			body, _ := os.ReadFile(filepath.Join(dir, "body"))
			for _, w := range tt.wantBody {
				if !strings.Contains(string(body), w) {
					t.Errorf("the report lacks %q:\n%s", w, body)
				}
			}
			for _, n := range tt.noBody {
				if strings.Contains(string(body), n) {
					t.Errorf("the report has %q:\n%s", n, body)
				}
			}
		})
	}
}
