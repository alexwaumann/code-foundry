package api

import (
	"encoding/json"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A provisional name is marked on the wire (and so in the CLI's --json); a real one
// leaves the field out.
func TestThreadToProtoNameProvisional(t *testing.T) {
	for _, tt := range []struct {
		name        string
		s           thread.Thread
		provisional bool
	}{
		{"provisional", thread.Thread{ID: "s1", Name: "fix the login redirect", NameProvisional: true}, true},
		{"named", thread.Thread{ID: "s2", Name: "Fix the login redirect", AutoNamed: true}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := threadToProto(tt.s)
			if p.GetName() != tt.s.Name || p.GetNameProvisional() != tt.provisional {
				t.Errorf("proto = name %q provisional %v", p.GetName(), p.GetNameProvisional())
			}
			b, err := protojson.Marshal(p)
			if err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			if got := m["nameProvisional"] == true; got != tt.provisional {
				t.Errorf("json %s: nameProvisional present %v, want %v", b, got, tt.provisional)
			}
		})
	}
}
