package api

import (
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A user message says what became of it in Claude Code's queue, and when Claude read it
// (docs/notes/steer-segments.md), or that the user took it back.
func TestUserMessageDelivery(t *testing.T) {
	read := time.UnixMilli(1_700_000_000_000)
	tests := []struct {
		name   string
		item   thread.Item
		want   v1.MessageDelivery
		readAt bool
	}{
		{"taken in at once", thread.Item{}, v1.MessageDelivery_MESSAGE_DELIVERY_UNSPECIFIED, false},
		{"queued", thread.Item{Queued: true}, v1.MessageDelivery_MESSAGE_DELIVERY_QUEUED, false},
		{"read after a wait", thread.Item{ReadAt: read, PlacedAfter: 4}, v1.MessageDelivery_MESSAGE_DELIVERY_READ, true},
		{"never read", thread.Item{Unsent: true, PlacedAfter: 4}, v1.MessageDelivery_MESSAGE_DELIVERY_UNSENT, false},
		// Only the update that drops it carries it (docs/notes/cancel-queued-messages.md).
		{"cancelled", thread.Item{Cancelled: true}, v1.MessageDelivery_MESSAGE_DELIVERY_CANCELLED, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.item.ID, tt.item.Kind = "u", thread.KindUserMessage
			p := itemToProto(tt.item).GetUserMessage()
			if p.GetDelivery() != tt.want || p.GetQueued() != tt.item.Queued {
				t.Errorf("delivery %v queued %v, want %v", p.GetDelivery(), p.GetQueued(), tt.want)
			}
			if got := p.GetReadAt(); (got != nil) != tt.readAt || (tt.readAt && !got.AsTime().Equal(read)) {
				t.Errorf("read_at = %v", got)
			}
		})
	}
}
