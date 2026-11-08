package command

import (
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// A user-only refusal names the page and row it can find, and Settings when it finds none.
func TestUserOnlyRefusalPlace(t *testing.T) {
	pages := []*v1.SettingPage{{Id: "general", Title: "General"}, {Id: "source", Title: "Source control"}}
	const tail = "; a command from a thread (its terminal too), a page or a plugin cannot change it"
	for _, tc := range []struct {
		name string
		f    *v1.SettingField
		want string
	}{
		{"page and row", &v1.SettingField{Key: "gitops.editor_command", Page: "source", Title: "Editor command"}, "gitops.editor_command can only be changed by hand, in Settings → Source control → Editor command" + tail},
		{"page not listed", &v1.SettingField{Key: "x.y", Page: "gone", Title: "Y"}, "x.y can only be changed by hand, in Settings → Y" + tail},
		{"no title", &v1.SettingField{Key: "x.y", Page: "general"}, "x.y can only be changed by hand, in Settings → General" + tail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := userOnlyRefusal(tc.f, pages).Error(); got != tc.want {
				t.Errorf("got  %q\nwant %q", got, tc.want)
			}
		})
	}
}
