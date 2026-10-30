# The welcome page: a first run with no projects

{{cf.provenance}}

For the code-foundry-pages skill. A new install prefills the composer with "I just installed
Code Foundry and have no projects yet. This is the welcome tutorial: open the page
~/.code-foundry/pages/welcome.html in the side panel." The app writes that page at every
start, in the home's `pages` folder: here `{{cf.welcomePage}}` (the path the prompt names). Only
if that file is missing, copy `welcome.html` beside this file to
`$CODE_FOUNDRY_PAGES/welcome.html` and show the copy. Do not write or rewrite it, and build
nothing else; show it, then stop:

```sh
code-foundry view.panel.page "<the path>" --title "Welcome"
```

It opens in the side panel beside this conversation, not as an inline card (never
`view.inline`): the user learns the panel first; later pages they ask for show inline. Never clone or read the app's
source for this, and read no other skill first.

Then reply with exactly these two lines and nothing else:

> Your welcome page is open in the panel on the right: four steps, each a sentence you could
> type here. Start with the first bubble, or tell me which folder on this Mac, or GitHub
> repository, is your first project.

What the page does, so you can answer questions about it:

- **Step 1 bubbles** send their sentence to this thread as the user's message (`thread.send`);
  a sent bubble shows follow-ups (theme settings, open memories, reset memory). Pencil bubbles
  stage the words in the composer (`composer.stage`) for the user to finish.
- **Step 2**: Add a project opens the Add Project dialog (`project.add`). This thread has no
  project and keeps none: new threads use the project.
- **Step 3** unlocks once a project exists. Run the demo sends one sentence naming the project
  (name and id) and asking you to start three read-only threads on it
  (`thread.new --project <id> --prompt … --notify --sidebar=false`; created-by is you by
  default). The page's own board lists your children live and reads their state (working,
  finished, needs permission, asked a question), so: NO sidebar rows, NO board or page of your
  own, no edits, and one line back when the three are started. When they wake you, one line
  each is enough; the user reads their results on the board by clicking a row.
- The to-do bubble asks for a page that keeps everything the user does on it between visits:
  when you build it, store every state it has (ticks, text, order) in `cf.storage`.
- **Step 4**: the dictation switch downloads the model first when it is missing
  (`dictation.download`), else sets `dictation.enabled`.
- Progress is kept in the page's storage, so the page remembers what was done.

Change the page only when the user asks for something different, with your file tools, in
`$CODE_FOUNDRY_PAGES`, never in this folder.
