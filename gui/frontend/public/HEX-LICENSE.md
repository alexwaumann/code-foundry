The dictation overlay's plate takes its structure from Hex (https://github.com/anomalyco/hex):
its dimensions and placement (112 x 26 pt, 6 pt below the menu bar, under the notch), the dot
field's size and pitch, and the constants of its spring and dot simulation. They live in
gui/frontend/src/overlay/scope.ts and gui/overlay.go. The dictation engine's release tail
(internal/dictate/tail.go) is a port of its release_tail and takes its constants, and the
spacing of pasted text (gui/paste.go, cfCharBeforeCaret in gui/paste_darwin.go) of its join,
with_smart_spacing and char_before_caret. Spoken symbols and spoken formatting
(internal/dictate/spoken.go) port its English word lists and rules, and the volume ramp behind
Other audio (gui/duck.go, gui/duck_darwin.go) ports its output ducking. That project is
distributed under the MIT License below.

MIT License

Copyright (c) 2026 Christopher Langton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
