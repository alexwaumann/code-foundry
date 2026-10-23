package theme

import (
	"maps"
	"slices"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ToProto is f as the API's UserTheme (ThemeService's snapshot, a thread's theme card),
// with its file's path ("" for none).
func ToProto(f File, path string) *v1.UserTheme {
	b := f.Base
	return &v1.UserTheme{
		Id: f.ID, Name: f.Name, Scheme: f.Scheme, Pair: f.Pair, From: f.From, CreatedBy: f.CreatedBy, Source: f.Source,
		Base: &v1.ThemeBase{
			Canvas: b.Canvas, Surface: b.Surface, Text: b.Text, Accent: b.Accent,
			Success: b.Success, Warning: b.Warning, Error: b.Error, Info: b.Info, Highlight: b.Highlight, Link: b.Link,
			Terminal: &v1.ThemeTerminal{
				Foreground: b.Terminal.Foreground, Cursor: b.Terminal.Cursor, CursorText: b.Terminal.CursorText,
				Selection: b.Terminal.Selection, Ansi: slices.Clone(b.Terminal.ANSI),
			},
		},
		Overrides: maps.Clone(f.Overrides),
		Path:      path,
	}
}

// FromProto is the file a UserTheme holds (its path dropped), not validated: ParseFile
// its Marshal to check it.
func FromProto(t *v1.UserTheme) File {
	b, term := t.GetBase(), t.GetBase().GetTerminal()
	f := File{
		ID: t.GetId(), Name: t.GetName(), Scheme: t.GetScheme(), Pair: t.GetPair(), From: t.GetFrom(), CreatedBy: t.GetCreatedBy(), Source: t.GetSource(),
		Base: Base{
			Canvas: b.GetCanvas(), Surface: b.GetSurface(), Text: b.GetText(), Accent: b.GetAccent(),
			Success: b.GetSuccess(), Warning: b.GetWarning(), Error: b.GetError(), Info: b.GetInfo(), Highlight: b.GetHighlight(), Link: b.GetLink(),
			Terminal: Terminal{
				Foreground: term.GetForeground(), Cursor: term.GetCursor(), CursorText: term.GetCursorText(),
				Selection: term.GetSelection(), ANSI: slices.Clone(term.GetAnsi()),
			},
		},
	}
	if len(t.GetOverrides()) > 0 {
		f.Overrides = maps.Clone(t.GetOverrides())
	}
	return f
}
