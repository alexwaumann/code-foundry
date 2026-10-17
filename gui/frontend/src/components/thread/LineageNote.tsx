import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useNow } from "@/lib/clock";
import { formatAgo } from "@/lib/thread";
import { CodeBlock } from "./Code";

/** An expandable note's body: a code block under a small label ("Wake payload", "JSON"). */
export interface LineageNoteBody {
  /** Shown above the block, muted ("Wake payload"). */
  label: string;
  /** The block's language for highlighting ("json"); also shown after the label. */
  lang: string;
  code: string;
}

/** "just now", "5 min ago": the note's age on the shared 30 s clock. */
function Age({ atMs }: { atMs: number }) {
  const now = useNow(30_000);
  return <>{formatAgo(atMs, now)}</>;
}

/**
 * A lineage note in a thread's timeline (docs/notes/agents-3-lineage-gui.md, the sketch's
 * `.lnote`): one muted line on a faint fill with a hairline, an icon at the left, the
 * content (a thread's name as a link, a muted summary that ellipsises), the age on the
 * right. Not a bubble and not the centred "Forked from" divider.
 *
 * With a `body` the line is a toggle: a chevron after the age, and once open the body as a
 * code block under it (PR 4 feeds a wake payload through it). Without one it is static.
 */
export function LineageNote({ icon, children, atMs, body, defaultOpen = false, testId }: { icon: ReactNode; children: ReactNode; atMs: number | null; body?: LineageNoteBody | null; defaultOpen?: boolean; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Boolean(body);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="lnote" role="note" data-testid={testId} data-open={(expandable && open) || undefined}>
      <div
        className="ln"
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        data-testid={testId ? `${testId}-line` : undefined}
        onClick={
          expandable
            ? () => {
                setOpen((o) => !o);
              }
            : undefined
        }
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setOpen((o) => !o);
              }
            : undefined
        }
      >
        {icon}
        {children}
        {atMs !== null && (
          <span className="ago" data-testid={testId ? `${testId}-age` : undefined}>
            <Age atMs={atMs} />
          </span>
        )}
        {expandable && <Chevron className="chev" aria-hidden />}
      </div>
      {body && open && (
        <div className="lbody" data-testid={testId ? `${testId}-body` : undefined}>
          <div className="lhead">
            {body.label}
            {body.lang && <span className="lang">{body.lang.toUpperCase()}</span>}
          </div>
          <CodeBlock lang={body.lang} code={body.code} />
        </div>
      )}
    </div>
  );
}
