package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// RESTWriter is implemented by runners that can make REST requests that change things
// (POST, PATCH, PUT, DELETE). HTTPRunner does. The store sends review requests through
// it; without it SetReviewRequest fails.
type RESTWriter interface {
	// RESTWrite sends method <api root>/<path> with body as JSON (nil sends none) and
	// returns the response body. Errors are classified like REST's; HTTP 422 (GitHub
	// refused the change) is ErrFailedPrecondition. It is never retried, except once on
	// a 401 when gh has a new token (the request was not executed).
	RESTWrite(ctx context.Context, method, path string, body any) (json.RawMessage, error)
}

var _ RESTWriter = (*HTTPRunner)(nil)

// RESTWrite implements RESTWriter.
func (r *HTTPRunner) RESTWrite(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	switch method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return nil, fmt.Errorf("%w: REST write method %q", ErrInvalidArgument, method)
	}
	var b []byte
	if body != nil {
		var err error
		if b, err = json.Marshal(body); err != nil {
			return nil, fmt.Errorf("github: encode request: %w", err)
		}
	}
	res, err := r.do(ctx, method, r.opts.BaseURL+"/"+strings.TrimPrefix(path, "/"), b)
	if err != nil {
		return nil, err
	}
	if res.status == http.StatusUnprocessableEntity {
		return nil, fmt.Errorf("%w: %s", ErrFailedPrecondition, restErrorMessage(res))
	}
	if !res.ok() {
		return nil, classifyHTTP(res)
	}
	return res.body, nil
}

// restErrorMessage is httpMessage plus GitHub's validation details, which for a 422
// say what was wrong ("Review cannot be requested from pull request author.").
func restErrorMessage(res httpResult) string {
	var body struct {
		Errors []json.RawMessage `json:"errors"`
	}
	msg := httpMessage(res)
	if json.Unmarshal(res.body, &body) != nil {
		return msg
	}
	var details []string
	for _, e := range body.Errors {
		var s string
		if json.Unmarshal(e, &s) == nil && s != "" {
			details = append(details, s)
			continue
		}
		var o struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(e, &o) == nil && o.Message != "" {
			details = append(details, o.Message)
		}
	}
	if len(details) == 0 {
		return msg
	}
	return msg + ": " + strings.Join(details, "; ")
}
