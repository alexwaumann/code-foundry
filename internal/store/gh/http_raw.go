package gh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

var _ RawRESTRunner = (*HTTPRunner)(nil)

// RESTRaw implements RawRESTRunner.
func (r *HTTPRunner) RESTRaw(ctx context.Context, path string, params map[string]string, accept string, limit int64) (RawResponse, error) {
	if accept == "" || limit <= 0 {
		return RawResponse{}, fmt.Errorf("%w: raw REST needs an Accept and a positive limit", ErrInvalidArgument)
	}
	res, err := r.do(ctx, http.MethodGet, r.restURL(path, params), nil, sendOpts{accept: accept, limit: limit})
	if err != nil {
		return RawResponse{}, err
	}
	switch {
	case res.status == http.StatusNotAcceptable, res.status == http.StatusUnprocessableEntity:
		return RawResponse{}, fmt.Errorf("%w: %s", ErrFailedPrecondition, restErrorMessage(res))
	case !res.ok():
		return RawResponse{}, classifyHTTP(res)
	}
	return RawResponse{Body: res.body, Truncated: res.truncated, ContentType: res.header.Get("Content-Type")}, nil
}

// errNoRawRunner is returned when the runner cannot make raw REST requests (test
// fakes without RESTRaw).
var errNoRawRunner = errors.New("gh: the runner cannot make raw REST requests")
