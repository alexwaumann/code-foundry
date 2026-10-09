package gh

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Fixtures in testdata/ are real GitHub GraphQL response bodies captured with the
// queries in queries/ and poll_query.go (viewer identity sanitized to octocat), except
// files named *_synthetic.json. See docs/notes/gh-viewer-polling.md.

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fixtureData returns a fixture's "data" object, as Runner.GraphQL does (with its
// *PartialError when the body also has errors).
func fixtureData(t *testing.T, name string) json.RawMessage {
	t.Helper()
	data, err := parseGraphQLResponse(httpResult{status: 200, body: fixture(t, name)})
	if err != nil && !isPartial(err) {
		t.Fatalf("%s: %v", name, err)
	}
	return data
}
