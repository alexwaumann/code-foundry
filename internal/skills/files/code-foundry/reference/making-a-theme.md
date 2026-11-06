# Making a theme

{{cf.provenance}}

Every colour change is `code-foundry theme save --file <path> --apply` (a card with Undo); never
edit the themes folder. Verbs: `theme list|show|save|check|edit|duplicate|delete|restore|set-dark|`
`set-light|set-scheme|ask`. Copy the closest (`theme show <id>`) into `$CODE_FOUNDRY_PAGES` with a
new `id`, `name` and `from` (the theme copied; `pair` only for your own). Change base colours first;
pin `overrides` only where a rule is wrong ({{cf.themesRef}}). Body text keeps 7:1, status text
4.5:1: for less contrast move `surface` and `canvas` toward the text, never the text. Fix every
pair the save's `contrast:` lists before you reply. A theme this thread did not make needs
`--replace`, once the user asked to change it. A light theme while the app is dark changes nothing
on screen: say so, offer `theme set-scheme light`, never switch unasked. Reply in a sentence or two.
