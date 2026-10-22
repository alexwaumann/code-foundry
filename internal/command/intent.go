package command

import (
	"encoding/json"
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
)

// IntentEvent is the bus event carrying a UI intent to every UiService.WatchIntents
// stream. The intent must not be mutated after publishing; watchers share it.
type IntentEvent struct {
	Intent *v1.UiIntent
}

// Emitter sends UI intents to connected GUIs.
type Emitter interface {
	// Emit sends intent and reports how many bus subscriptions received it. That is not
	// a window count: the events hub's one subscription serves every EventService.Watch
	// stream, an app window's and a CLI events stream's alike, and plugins subscribe
	// too.
	Emit(intent *v1.UiIntent) (receivers int)
	// Windows is the number of app windows connected now (api.Clients.Windows): the ones
	// an intent can show something in.
	Windows() int
}

// BusEmitter publishes intents as IntentEvent on a bus. UiService.Emit and the ui.*
// commands share it, so both count the same watchers.
type BusEmitter struct {
	Bus *bus.Bus
	// CountWindows counts the app windows connected (api.Clients.Windows). Nil: none.
	CountWindows func() int
}

// Emit publishes intent without blocking. Watchers with full buffers miss it and are
// not counted.
func (e BusEmitter) Emit(intent *v1.UiIntent) int {
	return bus.Publish(e.Bus, IntentEvent{Intent: intent})
}

// Windows is CountWindows, 0 without it.
func (e BusEmitter) Windows() int {
	if e.CountWindows == nil {
		return 0
	}
	return e.CountWindows()
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
