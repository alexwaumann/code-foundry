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

// RawResponse is a REST response body in a media type other than JSON.
type RawResponse struct {
	Body []byte
	// Truncated: the body was longer than the limit asked for; Body holds that many
	// bytes.
	Truncated bool
	// ContentType is the response's Content-Type (GitHub answers a raw contents
	// request for a directory with its JSON listing).
	ContentType string
}

// RawRESTRunner is implemented by runners that can GET a REST resource in a custom
// media type (a pull request's diff, a file's raw contents). HTTPRunner does; without
// it GetPullRequestDiff and GetPullRequestFile fail.
type RawRESTRunner interface {
	// RESTRaw runs GET <api root>/<path> with params as query parameters and accept as
	// the Accept header, reading at most limit bytes of the body. Errors are
	// classified like REST's; HTTP 406 and 422 (GitHub cannot render the resource in
	// that media type, e.g. a diff too large) are ErrFailedPrecondition.
	RESTRaw(ctx context.Context, path string, params map[string]string, accept string, limit int64) (RawResponse, error)
}
