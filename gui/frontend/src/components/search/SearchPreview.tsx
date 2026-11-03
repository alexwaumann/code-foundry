import { useLayoutEffect, useMemo, useRef } from "react";
import { ChevronRight } from "lucide-react";
import type { ThreadItemView } from "@/api/thread";
import { ThreadMarkdown } from "@/components/thread/Code";
import { ThreadContext } from "@/components/thread/context";
import { UserBubble } from "@/components/thread/UserBubble";
import { sentTime } from "@/lib/format";
import { questionText } from "@/lib/threadFind";
import { useThreadsStore } from "@/stores/threads";
import { useThreadPlace } from "@/components/thread/useThreadPlace";
import { clearPreviewPaint, DOC_ATTR, messageMatchCount, paintPreview, previewCaption, type PreviewSubject } from "./preview";
import type { PreviewData } from "./useSearch";
import "@/components/thread/thread.css";
import "@/components/thread/codeActions.css";
import "./search.css";

/** A message as the timeline draws it: the user's bubble, Claude's markdown, a question with its answers. */
function Message({ item, doc }: { item: ThreadItemView; doc: "hit" | "context" }) {
  switch (item.kind) {
    case "user":
      return (
        <div className={doc === "context" ? "opacity-60" : undefined} {...{ [DOC_ATTR]: doc }}>
          <UserBubble text={item.text} composerText={item.composerText} attachments={item.attachments} createdAtMs={null} testId={doc === "context" ? "search-preview-prompt" : "search-preview-user"} />
        </div>
      );
    case "text":
      return (
        <div className="a-md selectable" data-testid="search-preview-text" {...{ [DOC_ATTR]: doc }}>
          <ThreadMarkdown>{item.text}</ThreadMarkdown>
        </div>
      );
    case "question":
      return (
        <div className="flex flex-col gap-1 text-body whitespace-pre-wrap" data-testid="search-preview-question" {...{ [DOC_ATTR]: doc }}>
          {questionText(item.request.inputJson, item.request.answers)}
        </div>
      );
    default:
      return null;
  }
}

function speakerLine(s: PreviewSubject): string {
  if (s.kind === "thread") return "Latest from Claude";
  return s.speaker === "user" ? "You" : s.speaker === "question" ? "Claude asked" : "Claude";
}

/**
 * The right side of the Find dialog: the crumb (project › thread name), the time and
 * "archived"; the selected message drawn as the timeline draws it with the query's
 * matches painted (Claude's text under the prompt it answers, dimmed); a caption with the
 * match count. A thread-name row shows the thread's latest text from Claude.
 */
export function SearchPreview({ subject, data, query }: { subject: PreviewSubject; data: PreviewData | null; query: string }) {
  const place = useThreadPlace(subject.threadId);
  const cwd = useThreadsStore((s) => s.byId[subject.threadId]?.worktreePath ?? "");
  const ctx = useMemo(() => ({ threadId: subject.threadId, cwd }), [subject.threadId, cwd]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const item = data?.item ?? null;
  const prompt = data?.prompt ?? null;
  const paintQuery = subject.kind === "hit" ? query : "";
  useLayoutEffect(() => {
    paintPreview(bodyRef.current, paintQuery);
  }, [item, prompt, paintQuery]);
  useLayoutEffect(() => clearPreviewPaint, []);
  const count = item && subject.kind === "hit" ? messageMatchCount(item, query) : 0;
  const project = place.set ?? place.project;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="search-preview" data-thread={subject.threadId}>
      <div className="flex shrink-0 items-baseline gap-2 px-5 pt-4 pb-2">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-body-sm" data-testid="search-preview-crumb">
          <span className="max-w-[45%] shrink-0 truncate text-cf-text-muted">{project}</span>
          <ChevronRight className="size-3 shrink-0 self-center text-cf-text-muted" aria-hidden />
          <span className="truncate font-medium text-cf-text">{subject.threadName || subject.threadId}</span>
        </span>
        <span className="shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="search-preview-when">
          {[sentTime(subject.atMs), subject.archived ? "archived" : ""].filter(Boolean).join(" · ")}
        </span>
      </div>
      <ThreadContext.Provider value={ctx}>
        <div ref={bodyRef} className="cf-thread min-h-0 flex-1 overflow-y-auto px-5 pb-4" data-testid="search-preview-body">
          {data?.error ? (
            <p className="text-caption text-cf-error-text" role="alert">
              Cannot show the message: {data.error}
            </p>
          ) : data && !item ? (
            <p className="text-caption text-cf-text-muted">{subject.kind === "thread" ? "No reply from Claude yet." : "This message is no longer in the thread."}</p>
          ) : item ? (
            <>
              {prompt && <Message item={prompt} doc="context" />}
              <p className="mt-2 text-caption text-cf-text-muted" data-testid="search-preview-speaker">
                {speakerLine(subject)}
              </p>
              <Message item={item} doc="hit" />
            </>
          ) : null}
        </div>
      </ThreadContext.Provider>
      {subject.kind === "hit" && item && (
        <div className="mx-5 shrink-0 border-t py-2 text-caption text-cf-text-muted" data-testid="search-preview-caption">
          {previewCaption(count, query)}
        </div>
      )}
    </div>
  );
}
