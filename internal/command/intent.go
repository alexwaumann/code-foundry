package command

import (
	"encoding/json"
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/bus"
)

// IntentEvent is the bus event carrying a UI intent to every UiService.WatchIntents
// stream. The intent must not be mutated after publishing; watchers share it.
type IntentEvent struct {
	Intent *v1.UiIntent
}

// Emitter sends UI intents to connected GUIs and reports how many received them.
type Emitter interface {
	Emit(intent *v1.UiIntent) (delivered int)
}

// BusEmitter publishes intents as IntentEvent on a bus. UiService.Emit and the ui.*
// commands share it, so both count the same watchers.
type BusEmitter struct {
	Bus *bus.Bus
}

// Emit publishes intent without blocking. Watchers with full buffers miss it and are
// not counted.
func (e BusEmitter) Emit(intent *v1.UiIntent) int {
	return bus.Publish(e.Bus, IntentEvent{Intent: intent})
}

// EncodeJSON encodes r.JSON for InvokeCommandResponse.result_json: protojson for proto
// messages (lowerCamel field names, like the TS client sees), encoding/json otherwise,
// and "" when there is no structured result.
func (r Result) EncodeJSON() (string, error) {
	if r.JSON == nil {
		return "", nil
	}
	var (
		b   []byte
		err error
	)
	if m, ok := r.JSON.(proto.Message); ok {
		b, err = protojson.Marshal(m)
	} else {
		b, err = json.Marshal(r.JSON)
	}
	if err != nil {
		return "", fmt.Errorf("encode result: %w", err)
	}
	return string(b), nil
}
