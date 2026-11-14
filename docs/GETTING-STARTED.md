# Code Foundry guide

<!-- The app's Help overlay shows this file from the first "## " heading on (Help >
Getting Started). Every button and shortcut it names must exist in the app. -->

## Getting started

A single surface for all your agents. Code Foundry runs coding agents (Claude Code
today) on the folders on your Mac, as many at once as you like, in one window.

Two words come up everywhere. A **project** is a folder on your Mac. A **thread** is
one conversation with an agent working in that folder. Threads keep working when you
close the window; a thread keeps its history, and a message always continues it.

New here, with no projects yet? Ask a thread for "the welcome tutorial": it opens a page of
four steps in a tab beside the conversation, and walks you through the app.

### Add a project

Click **New thread** at the top of the sidebar and pick **Add a project…** at the
bottom of the list, or click **Add project** on the Projects page (a pane's **+** ›
**Projects**). Then choose:

* **Local folder**: any folder in your home folder. A git repository works, and so
  does a plain folder.
* **GitHub**: copy a repository you have access to onto this Mac.
* **New**: start an empty project, and put it on GitHub if you like.

### Start a thread

The window opens on a new thread with **No project**: type and press Enter to ask
anything, working in your home folder. For a thread in a project, click **New thread**
(<kbd>⌘N</kbd>), pick the project, type what you want and press Enter. Paste or attach screenshots with the paperclip. Type <kbd>@</kbd> to mention a
file and <kbd>/</kbd> to run one of the project's skills or commands. To speak instead
of typing, turn on Settings › General › **Dictation** (a one-time model download; audio
never leaves your Mac), then press the microphone beside the paperclip, or hold
<kbd>⌥</kbd>, speak and let go, once macOS allows it (the **Allow** button there). Turn on
**Dictate anywhere** to do the same in any app: the text is pasted where you were typing.

Under the prompt, **Model** picks the model, **Effort** how hard it thinks, and
**Permissions** what it may do without asking: **Supervised** asks before edits and
commands, **Accept edits** edits files and asks for the rest, **Auto** lets Claude's
classifier decide. You can change all three in a running thread too.

### Where changes go

**Work in**, under the prompt, decides where the thread edits files:

* **The project folder itself** (the pill reads **Project folder**, or **Project
  folders** for several projects) edits your files where they are. This is the default.
* **A fresh copy of the project** (**Fresh copy**) gives the thread its own folder and
  branch, so several threads can work at once and you keep or discard each one. The app
  keeps these copies under `~/.code-foundry/worktrees`.
* **An existing branch**, found by name below the two, puts the thread on that branch
  in its own copy (the one it already has, if any).

A choice applies to that thread only; the next one starts from the default again. Set
the default for every project under Settings › General › **New threads work in**.

### Right after you send

The thread opens at once with your message, while its copy of the project is made. A
line per step shows anything that takes a moment. You can add to your message meanwhile:
it goes in when Claude starts. **Cancel** stops it and removes what it made.

If a step fails, or you cancelled, the thread says why and your message waits. **Try
again** picks up where it stopped, **Edit** brings everything back to the new-thread
composer as if you had never sent it, and **Remove** forgets the thread.

### The window

The window is a sidebar and panes of tabs. A tab shows a thread, its diff, a file, a pull
request, a terminal, or the Pull Requests or Projects page; **+** at the end of a pane's
tabs opens one there. Drag a tab, or a whole pane by the empty part of its tab strip: into
another pane, onto a pane's edge to split it, or onto the window's edge. Drag the gap
between two panes to resize them. <kbd>⇧⌘↩</kbd> shows one pane over all of them, and
<kbd>esc</kbd> brings the others back. A small window folds some panes into narrow strips
of icons; click one to open it.

What a thread opens (its diff, a file, a pull request, a terminal) is a tab beside it, with
a line under the tabs naming the thread. <kbd>⌘W</kbd> closes a tab. Closing a thread's
tab never archives it: its other tabs close with it and come back when you open the
thread again.

**Spaces** are the tabs in the bar at the top: separate layouts, each with its own threads.
**+** adds one and a double click renames it; <kbd>⌃⌘1</kbd> to <kbd>⌃⌘9</kbd> switch.
Drop a tab, a pane or a thread onto a space to move it there; a pane takes its threads
along. <kbd>⌘[</kbd> and <kbd>⌘]</kbd> go
back and forward through what you looked at, across panes and spaces.

<kbd>⌘J</kbd> opens the thread's quick terminal under its conversation, a shell in the
thread's folder; press it again to close it. <kbd>⌘T</kbd> opens a terminal tab in the
thread's folder, <kbd>⇧⌘T</kbd> one in your home folder. Closing a terminal's tab ends it.

### While it runs

The sidebar lists this space's threads. **Needs you** at the top lists the threads
waiting on you: a question, a permission, a plan to approve. Hover one to see the whole
ask (a command can be allowed or denied right there), click its title to answer in a
popup, or press <kbd>⇧⌘A</kbd> for the next one. A thread's tab shows a dot while it
waits. The window title and the badge on the Dock icon count what is waiting.

When a thread's agent starts threads of its own, they belong to that thread: they stay
out of the sidebar and the Dock badge, and its thread info card lists them. Click one
there to open it. To carry its work on yourself, fork it or start a new thread.

Tell any thread how you like things done ("keep your answers short", "always open pull
requests as drafts") and it keeps that as a standing preference for every thread in
every project; a **Remembered** notice confirms it. Settings › **Memory** lists them,
with when and by which thread, and forgets one or all. Ask a thread what it remembers,
or to forget one.

Closing the window stops nothing. Open the app again and every thread is where you
left it.

### Review and ship

The thread info card (<kbd>⇧⌘I</kbd>) beside the conversation shows more about the
selected thread: its projects and branch, what changed, its pull requests, the agents and
threads it started, its MCP servers and what it cost. Its **Changes** row opens the thread's
diff in a tab beside it (<kbd>⇧⌘D</kbd>, again to go back) on the changed files and commits.
Or ask the thread: "what changed?", "what did this cost?".

When the work is done, ask the agent to commit and open a pull request, or use
**Create Pull Request** from the command palette. Its pull request tab (the thread's
**⋯** › **Open**) follows its checks and reviews.

### Find anything

<kbd>⌘K</kbd> opens the command palette: every action in the app, searchable by name.
<kbd>⌘P</kbd> finds a file by name and opens it in a tab.
<kbd>⌘/</kbd> opens this guide; its **Keyboard shortcuts** tab lists every shortcut.
The **Help** menu has this guide too, and a way to report a problem.

## Install on another Mac

You need a Mac with Apple silicon. In a terminal:

1. Install the GitHub CLI (`gh`) and sign in: `gh auth login`.
2. Install Claude Code and sign in once: run `claude`, then quit it.
3. Run the installer:
   `gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash`
4. Open a new terminal and run `code-foundry gui`.

The window opens like any app; keep it in the Dock. The
[README](https://github.com/alexwaumann/code-foundry#install) has the details and the
installer's options.

## Settings

Open Settings with <kbd>⌘,</kbd> or **Code Foundry › Settings…**. You can change the
default model and effort for new threads, where new threads work, the theme and zoom,
Dock alerts and sounds, and every keyboard shortcut. Each setting says what it does,
and the search box at the top finds one by name.
