package gh

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// openTestDB opens a fresh SQLite file with the gh schema applied.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	return openTestDBAt(t, filepath.Join(t.TempDir(), "gh.sqlite"))
}

func openTestDBAt(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(wal)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestMigrateIdempotent(t *testing.T) {
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'gh_%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Errorf("gh tables = %d, want 4", n)
	}
}

func TestCacheRoundTrip(t *testing.T) {
	ctx := context.Background()
	c := cache{db: openTestDB(t)}
	at := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)

	empty, err := c.loadSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Viewer.Viewer != nil || len(empty.Repos) != 0 || !empty.Viewer.Authenticated {
		t.Errorf("empty snapshot = %+v", empty)
	}

	v := Viewer{Login: "octocat", Name: "The Octocat"}
	prs := []PullRequest{{Number: 1, Title: "one", UpdatedAt: at, Checks: CheckRollup{State: RollupSuccess, Total: 2, Passed: 2}}}
	if err := c.saveViewer(ctx, v, at); err != nil {
		t.Fatal(err)
	}
	if err := c.savePullRequests(ctx, "o/r", prs, 7, at); err != nil {
		t.Fatal(err)
	}
	// Upsert replaces.
	prs[0].Title = "one (edited)"
	if err := c.savePullRequests(ctx, "o/r", prs, 8, at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	snap, err := c.loadSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Viewer.Viewer == nil || *snap.Viewer.Viewer != v || !snap.Viewer.FetchedAt.Equal(at) {
		t.Errorf("viewer = %+v", snap.Viewer)
	}
	r := snap.Repos["o/r"]
	if r.Slug != "o/r" || r.TotalCount != 8 || len(r.PullRequests) != 1 || r.PullRequests[0].Title != "one (edited)" ||
		!r.FetchedAt.Equal(at.Add(time.Minute)) || r.Tracked {
		t.Errorf("repo = %+v", r)
	}

	d := PullRequestDetail{PullRequest: prs[0], Checks: []CheckRun{{Name: "ci", Status: StatusCompleted}}, FetchedAt: at}
	if err := c.saveDetail(ctx, "o/r", d); err != nil {
		t.Fatal(err)
	}
	got, ok, err := c.loadDetail(ctx, "o/r", 1)
	if err != nil || !ok || got.Checks[0].Name != "ci" || !got.FetchedAt.Equal(at) {
		t.Errorf("detail = %+v ok=%v err=%v", got, ok, err)
	}
	if _, ok, err := c.loadDetail(ctx, "o/r", 2); ok || err != nil {
		t.Errorf("missing detail ok=%v err=%v", ok, err)
	}

	rc := RefChecks{SHA: "abc", Runs: []CheckRun{{Name: "x"}}, FetchedAt: at}
	if err := c.saveChecks(ctx, "o/r", "main", rc); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := c.loadChecks(ctx, "o/r", "main"); err != nil || !ok || got.SHA != "abc" {
		t.Errorf("checks = %+v ok=%v err=%v", got, ok, err)
	}

	// Prune drops old on-demand rows only.
	if err := c.prune(ctx, at.Add(cacheRetention+time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := c.loadDetail(ctx, "o/r", 1); ok {
		t.Error("detail survived prune")
	}
	if _, ok, _ := c.loadChecks(ctx, "o/r", "main"); ok {
		t.Error("checks survived prune")
	}
	if snap, _ := c.loadSnapshot(ctx); len(snap.Repos) != 1 {
		t.Error("prune dropped the PR list")
	}
}

func TestCacheIgnoresOtherVersions(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	if _, err := db.Exec(`INSERT INTO gh_pull_requests (slug, fetched_at, total_count, payload)
		VALUES ('o/old', 1, 1, '{"v":0,"data":[{"number":1}]}'), ('o/bad', 1, 1, 'not json')`); err != nil {
		t.Fatal(err)
	}
	snap, err := cache{db: db}.loadSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Repos) != 0 {
		t.Errorf("repos = %+v, want stale rows ignored", snap.Repos)
	}
}
