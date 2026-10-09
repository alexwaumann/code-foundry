package gh

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestDumpQueries writes every static query document, plus request bodies for the poll
// and DefaultBranchChecks documents of the poll fixtures (fixturePlan), to
// $GH_DUMP_QUERIES, for recapturing fixtures by hand:
//
//	GH_DUMP_QUERIES=/tmp/q go test ./internal/store/gh -run TestDumpQueries
//	gh api graphql -F query=@/tmp/q/pull_request_details.graphql -f open[]=PR_… -f closed[]=PR_…
//	curl -H "Authorization: bearer $(gh auth token)" -X POST https://api.github.com/graphql --data @/tmp/q/poll_me.json
func TestDumpQueries(t *testing.T) {
	dir := os.Getenv("GH_DUMP_QUERIES")
	if dir == "" {
		t.Skip("set GH_DUMP_QUERIES=<dir> to write the assembled queries")
	}
	qs, err := loadQueries()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, b []byte) {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for name, q := range qs {
		write(name+".graphql", []byte(q))
	}
	body := func(doc string, vars map[string]any, err error) []byte {
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(map[string]any{"query": doc, "variables": vars})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for name, login := range map[string]string{"poll_me.json": "@me", "poll_mitchellh.json": "mitchellh"} {
		write(name, body(fixturePlan(login).build()))
	}
	write("default_branch_checks.json", body(defaultBranchChecksDoc([]ciRequest{
		{"neovim/neovim", "402a494f47808442f3de9266b147b274f8c7a5be"}, {"alexwaumann/code-foundry", "cfd8bdf4f3da13280a2186a0be3cbcb88fa1dd7e"}})))
}
