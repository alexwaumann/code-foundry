package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// More than 100 checks: the detail fetches more pages with Checks. A failed page keeps
// what was fetched and says so; running out of pages (MaxPages) truncates silently.
func TestFullPullRequestChecksPaging(t *testing.T) {
	base := fixtureData(t, "pull_request_full_cf_1.json")
	var first map[string]any
	if err := json.Unmarshal(base, &first); err != nil {
		t.Fatal(err)
	}
	pr := first["repository"].(map[string]any)["pullRequest"].(map[string]any)
	headSHA := pr["headRefOid"].(string)
	contexts := pr["checks"].(map[string]any)["contexts"].(map[string]any)
	contexts["pageInfo"] = map[string]any{"hasNextPage": true, "endCursor": "c1"}
	full, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	page := func(name, cursor string, more bool) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"repository":{"object":{"oid":%q,"statusCheckRollup":{"state":"FAILURE","contexts":{
			"checkRunCount":1,"checkRunCountsByState":[],"statusContextCount":0,"statusContextCountsByState":[],
			"pageInfo":{"hasNextPage":%v,"endCursor":%q},
			"nodes":[{"__typename":"CheckRun","name":%q,"status":"COMPLETED","conclusion":"FAILURE"}]}}}}}`, headSHA, more, cursor, name))
	}
	var mu sync.Mutex
	failAfter := "" // the cursor whose page fails
	var afters []string
	f := &fakeRunner{}
	f.set(func(op string, vars map[string]any) (json.RawMessage, error) {
		mu.Lock()
		defer mu.Unlock()
		switch op {
		case "PullRequestFull":
			return full, nil
		case "Checks":
			after, _ := vars["after"].(string)
			afters = append(afters, after)
			if vars["ref"] != headSHA {
				t.Errorf("checks ref = %v", vars["ref"])
			}
			switch {
			case after == failAfter:
				return nil, errors.New("github graphql: something went wrong")
			case after == "c1":
				return page("page-2", "c2", true), nil
			case after == "c2":
				return page("page-3", "c3", true), nil
			}
		}
		return nil, fmt.Errorf("unexpected %s %v", op, vars)
	})
	opts := testOptions(openTestDB(t), f, nil)
	opts.MaxPages = 3
	s := startStore(t, opts)
	ctx := context.Background()
	names := func(d FullPullRequest) string {
		var out []string
		for _, c := range d.Checks {
			out = append(out, c.Name)
		}
		return strings.Join(out, ",")
	}

	// Three pages (MaxPages), and GitHub has more: truncated, no error.
	d, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(d); got != "page-2,page-3,check" || !d.ChecksTruncated || d.LastError != "" {
		t.Errorf("checks %s truncated %v lastError %q", got, d.ChecksTruncated, d.LastError)
	}
	if strings.Join(afters, ",") != "c1,c2" {
		t.Errorf("pages asked for after %v", afters)
	}

	// The third page fails: the first two are kept, and the error is reported.
	mu.Lock()
	failAfter, afters = "c2", nil
	mu.Unlock()
	d, err = s.FullPullRequest(ctx, "o/r", 1, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(d); got != "page-2,check" || !d.ChecksTruncated || !strings.Contains(d.LastError, "checks after the first 2") ||
		!strings.Contains(d.LastError, "something went wrong") {
		t.Errorf("checks %s truncated %v lastError %q", got, d.ChecksTruncated, d.LastError)
	}
}
