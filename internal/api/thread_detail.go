package api

import (
	"context"
	"encoding/json"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// addDetail fills p's fields that come from thread s's items (thread.DetailOf, the
// wake's rules): GetThread with with_detail.
func (h *Thread) addDetail(ctx context.Context, s thread.Thread, p *v1.Thread) error {
	items, err := h.store.Items(ctx, s.ID)
	if err != nil {
		return err
	}
	d := thread.DetailOf(s, items.Items)
	p.Pending, p.ReportStale = pendingDetailToProto(d.Pending), d.ReportStale
	return nil
}

// pendingDetailToProto maps a pending request; nil for none.
func pendingDetailToProto(r *thread.PendingDetail) *v1.ThreadPendingDetail {
	if r == nil {
		return nil
	}
	p := &v1.ThreadPendingDetail{Kind: r.Kind, RequestId: r.RequestID, Tool: r.Tool, Input: jsonValue(r.Input),
		Question: r.Question, Options: r.Options}
	for _, q := range r.Questions {
		p.Questions = append(p.Questions, &v1.ThreadPendingQuestion{Question: q.Question, Options: q.Options})
	}
	return p
}

// jsonValue is a wake's JSON value (a json.RawMessage, a string, nil) as a
// protobuf Value; nil for none, a string for JSON that does not parse.
func jsonValue(v any) *structpb.Value {
	switch v := v.(type) {
	case nil:
		return nil
	case string:
		return structpb.NewStringValue(v)
	case json.RawMessage:
		out := &structpb.Value{}
		if protojson.Unmarshal(v, out) != nil {
			return structpb.NewStringValue(string(v))
		}
		return out
	}
	out, err := structpb.NewValue(v)
	if err != nil {
		return nil
	}
	return out
}
