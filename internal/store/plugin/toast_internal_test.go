package plugin

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A plugin's view/toast as the host takes it, from the raw params an old or a new plugin
// sends (docs/notes/toast-plugin-levels.md): the level checked (success included, an
// unknown one info), text and description trimmed and cut, and a toast without an
// instance as the notification every window shows.
func TestPluginToasts(t *testing.T) {
	long := strings.Repeat("x", maxToastDescription+10)
	for _, tt := range []struct {
		name, params string
		want         SurfaceToast
		dropped      bool
		notify       *v1.UiIntent_Notify // without an instance
	}{
		{name: "an old plugin's toast is unchanged", params: `{"level":"info","text":"note saved"}`,
			want:   SurfaceToast{Level: "info", Text: "note saved"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "Hello", Body: "note saved"}},
		{name: "attention is a warning", params: `{"level":"attention","text":"quota low"}`,
			want:   SurfaceToast{Level: "attention", Text: "quota low"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_WARNING, Title: "Hello", Body: "quota low"}},
		{name: "error", params: `{"level":"error","text":"boom"}`,
			want:   SurfaceToast{Level: "error", Text: "boom"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_ERROR, Title: "Hello", Body: "boom"}},
		{name: "success", params: `{"level":"success","text":"Build #6 queued again"}`,
			want:   SurfaceToast{Level: "success", Text: "Build #6 queued again"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_SUCCESS, Title: "Hello", Body: "Build #6 queued again"}},
		{name: "a description: the text is the title", params: `{"level":"success","text":"Note saved","description":"  3 lines in notes.md  "}`,
			want:   SurfaceToast{Level: "success", Text: "Note saved", Description: "3 lines in notes.md"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_SUCCESS, Title: "Note saved", Body: "3 lines in notes.md"}},
		{name: "an instance's toast keeps its instance", params: `{"instance":"i-1","level":"info","text":"saved","description":"d"}`,
			want: SurfaceToast{Instance: "i-1", Level: "info", Text: "saved", Description: "d"}},
		{name: "an unknown level is info", params: `{"level":"celebrate","text":"t"}`,
			want:   SurfaceToast{Level: "info", Text: "t"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "Hello", Body: "t"}},
		{name: "no level is info", params: `{"text":"t"}`,
			want:   SurfaceToast{Level: "info", Text: "t"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "Hello", Body: "t"}},
		{name: "a blank description is none", params: `{"level":"info","text":"t","description":" \n "}`,
			want:   SurfaceToast{Level: "info", Text: "t"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "Hello", Body: "t"}},
		{name: "a long description is cut", params: `{"level":"info","text":"t","description":"` + long + `"}`,
			want:   SurfaceToast{Level: "info", Text: "t", Description: long[:maxToastDescription-1] + "…"},
			notify: &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "t", Body: long[:maxToastDescription-1] + "…"}},
		{name: "no text is no toast", params: `{"level":"success","text":"  "}`, dropped: true},
		{name: "a description alone is no toast", params: `{"level":"success","description":"detail"}`, dropped: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var p pluginsdk.ToastParams
			if err := json.Unmarshal([]byte(tt.params), &p); err != nil {
				t.Fatal(err)
			}
			got, ok := cleanToast(p)
			if ok == tt.dropped {
				t.Fatalf("ok = %v, want %v", ok, !tt.dropped)
			}
			if got != tt.want {
				t.Errorf("toast %+v, want %+v", got, tt.want)
			}
			if tt.notify != nil {
				if n := toastNotify(got, "Hello"); !proto.Equal(n, tt.notify) {
					t.Errorf("notify %v, want %v", n, tt.notify)
				}
			}
		})
	}
	if !slices.Contains(hostCapabilities, pluginsdk.ToastDescriptionCapability) {
		t.Errorf("capabilities %v, want %s", hostCapabilities, pluginsdk.ToastDescriptionCapability)
	}
}
