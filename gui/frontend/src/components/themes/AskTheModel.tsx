import { useState } from "react";
import { CornerDownLeft, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { askForTheme } from "@/stores/themeCards";
import { editorDirty, leaveEditor } from "@/stores/themeEditor";

/** The field's placeholder: what a description looks like. */
export const ASK_PLACEHOLDER = "Describe a theme… warm dark, teal accent, quieter sidebar";

/**
 * "Ask the model" in the Themes page's control bar (docs/notes/theme-model-flow.md): a
 * popover with one field; Enter or Send starts a thread with no project that makes the
 * theme described (theme.ask), which the daemon then opens. The thread is where the user
 * refines it. A failure is toasted and the text stays.
 */
export function AskTheModel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      // The thread opens in place of the page, and the model never sees the draft: unsaved edits are asked about first.
      if (editorDirty() && !(await leaveEditor("The model does not see them: asking starts a thread and leaves the editor. Drop them?"))) return;
      if (await askForTheme(text)) {
        setText("");
        setOpen(false);
      }
    } finally {
      setSending(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-auto text-cf-text-muted" data-testid="themes-ask">
          <Sparkles aria-hidden />
          Ask the model
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 p-2"
        aria-label="Ask the model for a theme"
        data-testid="themes-ask-popover"
        // The page's keys (arrows, Enter applies, Escape closes the page) stay out of the field.
        onKeyDown={(e) => {
          e.stopPropagation();
        }}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            autoFocus
            value={text}
            readOnly={sending}
            placeholder={ASK_PLACEHOLDER}
            aria-label="Describe a theme"
            className="h-8 flex-1 text-body-sm"
            data-testid="themes-ask-input"
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
          <Button type="submit" size="sm" className="h-8" disabled={sending || !text.trim()} data-testid="themes-ask-send">
            {sending ? <LoaderCircle className="animate-spin" aria-hidden /> : <CornerDownLeft aria-hidden />}
            Send
          </Button>
        </form>
        <p className="mt-1.5 px-1 text-caption text-cf-text-muted">Starts a thread that makes it and applies it; Undo is one click there.</p>
      </PopoverContent>
    </Popover>
  );
}
