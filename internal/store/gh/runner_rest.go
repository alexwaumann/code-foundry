package gh

import (
	"context"
	"encoding/json"
)

// RESTRunner is implemented by runners that can make REST GET requests. HTTPRunner
// does; a Runner without it (test fakes) makes the store fall back to GraphQL where a
// REST endpoint was preferred (commit counts, see activity.go).
type RESTRunner interface {
	// REST runs GET <api root>/<path> with params as query parameters and returns the
	// response body.
	REST(ctx context.Context, path string, params map[string]string) (json.RawMessage, error)
}
