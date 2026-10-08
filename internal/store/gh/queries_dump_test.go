package gh

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDumpQueries writes every assembled query document to $GH_DUMP_QUERIES, for running
// them by hand to recapture fixtures:
//
//	GH_DUMP_QUERIES=/tmp/q go test ./internal/store/gh -run TestDumpQueries
//	gh api graphql -F query=@/tmp/q/search_pull_requests.graphql -f q=... -f type=ISSUE ...
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
	for name, q := range qs {
		if err := os.WriteFile(filepath.Join(dir, name+".graphql"), []byte(q), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
