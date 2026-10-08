package gh

import (
	"context"
	"encoding/json"
	"sort"
)

// RESTRunner is implemented by runners that can make REST GET requests. ExecRunner
// does; a Runner without it (test fakes) makes the store fall back to GraphQL where a
// REST endpoint was preferred (commit counts, see activity.go).
type RESTRunner interface {
	// REST runs `gh api -X GET <path>` with params as query parameters and returns the
	// response body.
	REST(ctx context.Context, path string, params map[string]string) (json.RawMessage, error)
}

var _ RESTRunner = ExecRunner{}

// restArgs builds `gh api -X GET` arguments; -f values are never type-converted.
// Parameters are sorted for a deterministic argv.
func restArgs(path string, params map[string]string) []string {
	args := []string{"api", "-X", "GET", path}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-f", k+"="+params[k])
	}
	return args
}

// REST implements RESTRunner.
func (r ExecRunner) REST(ctx context.Context, path string, params map[string]string) (json.RawMessage, error) {
	stdout, stderr, code, err := r.run(ctx, restArgs(path, params)...)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, classifyFailure(code, stdout, stderr)
	}
	return stdout, nil
}
