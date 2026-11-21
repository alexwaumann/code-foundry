import { memo, useMemo, useState } from "react";
import { FileText, ImageIcon } from "lucide-react";
import type { DeliveryView } from "@/api/thread";
import { AttachmentLightbox } from "@/components/compose/AttachmentLightbox";
import { ChipFace, PdfTile } from "@/components/compose/attachmentFaces";
import { TAG_ACCENT, tagClass } from "@/components/compose/tagStyle";
import { usePrTagInfo, useThreadTagInfo } from "@/components/compose/useTagInfo";
import { Tip } from "@/components/ui/tooltip";
import { ATTACHMENT_GONE, attachmentChipTip, pageCount, previewLabel } from "@/lib/compose";
import { sentTime } from "@/lib/format";
import { formatAttachmentSize, kindFromName, middleTruncate, stagedPdfPages, tagLabel } from "@/lib/prompt";
import { inlineAttachmentPaths, parseUserMessage, promptCopyText } from "@/lib/userMessage";
import { useCopied } from "@/lib/useCopied";
import { cn } from "@/lib/utils";
import { type PdfSummary, useAttachment, usePdfSummary } from "@/stores/attachments";
import { useProjectsStore } from "@/stores/projects";
import { CiteChip } from "./cite/CiteChip";
import { GutterCopy } from "./GutterCopy";
import { MessageFold } from "./MessageFold";
import { DeliveryWord } from "./QueuedTag";

/** The image chip's accent: green, the success token. */
const IMAGE_ACCENT = "[--chip-accent:var(--cf-success)]";

/** A sent PDF's page count: the one the daemon put in its staged name, else pdf.js's (null while counting). */
function sentPages(path: string, summary: PdfSummary | null): number | null {
  return stagedPdfPages(path) ?? summary?.pages ?? null;
}

/** The lightbox for an attachment the message sent (AttachmentLightbox), with its size and a PDF's pages. */
function SentPreview({ open, onClose, path, name, pdf }: { open: boolean; onClose: () => void; path: string; name: string; pdf: boolean }) {
  const { url, file } = useAttachment(path);
  const summary = usePdfSummary(pdf ? path : "");
  return (
    <AttachmentLightbox
      open={open && url !== null}
      onClose={onClose}
      testId="thread-attachment-preview"
      kind={pdf ? "pdf" : "image"}
      name={name}
      size={file ? formatAttachmentSize(file.size) : ""}
      pages={pdf ? sentPages(path, summary) : null}
      url={url}
      file={file}
    />
  );
}

/**
 * An image or PDF the message sent, inline as the composer's chip: its mini thumbnail (a
 * PDF's first page) and name, and a PDF's page count (its size in the tooltip, with the
 * full name when the chip cuts it); a click previews it. A path the daemon no longer has
 * shows dashed, does nothing and says why in its tooltip.
 */
function AttachmentChip({ name, path, pdf }: { name: string; path: string; pdf: boolean }) {
  const { url, file, loading } = useAttachment(path);
  const summary = usePdfSummary(pdf ? path : "");
  const [open, setOpen] = useState(false);
  const size = file ? formatAttachmentSize(file.size) : "";
  const count = pdf ? sentPages(path, summary) : null;
  const pages = count === null ? "" : pageCount(count);
  const gone = !url && !loading;
  return (
    <>
      <Tip label={attachmentChipTip(name, [pages && size ? size : "", gone ? ATTACHMENT_GONE : ""])}>
        {/* A disabled button takes no hover: the span carries the tooltip. */}
        <span className="inline-flex max-w-full align-middle" data-testid="thread-tag-tip">
          <button
            type="button"
            data-testid="thread-tag"
            data-tag-kind={pdf ? "pdf" : "image"}
            data-pages={count ?? undefined}
            aria-label={pdf ? `PDF ${name}${pages ? `, ${pages}` : ""}` : `Image ${name}`}
            aria-haspopup="dialog"
            className={tagClass(false, cn(pdf ? TAG_ACCENT.file : IMAGE_ACCENT, url ? "cursor-pointer" : "border-dashed"))}
            disabled={!url}
            onClick={() => {
              setOpen(true);
            }}
          >
            <ChipFace pdf={pdf} src={pdf ? (summary?.thumb ?? null) : url} name={middleTruncate(name)} detail={pages} />
          </button>
        </span>
      </Tip>
      <SentPreview
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        path={path}
        name={name}
        pdf={pdf}
      />
    </>
  );
}

/** An attachment the text does not refer to: a tile above the bubble (an image, or a PDF's first page over a "PDF" strip). */
function Thumbnail({ path }: { path: string }) {
  const pdf = kindFromName(path) === "pdf";
  const { url, file } = useAttachment(path);
  const summary = usePdfSummary(pdf ? path : "");
  const pages = pdf ? sentPages(path, summary) : null;
  const [open, setOpen] = useState(false);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const Icon = pdf ? FileText : ImageIcon;
  return (
    <li className="size-16 overflow-hidden rounded-lg border bg-cf-surface-sunken/40" data-testid="thread-attachment" data-kind={pdf ? "pdf" : "image"} data-pages={pages ?? undefined}>
      {url ? (
        <button
          type="button"
          className="block size-full cursor-pointer"
          aria-label={previewLabel(name, pdf ? "pdf" : "image", pages, file ? formatAttachmentSize(file.size) : "")}
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
          }}
        >
          {pdf ? <PdfTile thumb={summary?.thumb ?? null} /> : <img src={url} alt={name} className="size-full object-cover" />}
        </button>
      ) : (
        <span className="flex size-full items-center justify-center text-cf-text-muted">
          <Icon className="size-4" aria-hidden />
        </span>
      )}
      <SentPreview
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        path={path}
        name={name}
        pdf={pdf}
      />
    </li>
  );
}

function FileChip({ projectId, path, line }: { projectId: string; path: string; line?: number | undefined }) {
  const project = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const at = line === undefined ? "" : `:${String(line)}`;
  return (
    <Tip label={`${project}/${path}${at}`}>
      <span data-testid="thread-tag" data-tag-kind="file" data-path={path} data-line={line} className={tagClass(false, TAG_ACCENT.file)}>
        <span className="truncate">{tagLabel({ tagKind: "file", projectId, path, ...(line === undefined ? {} : { line }) })}</span>
      </span>
    </Tip>
  );
}

/** Another thread, as the composer's tag: its current name; the tooltip says its project and status. */
function ThreadChip({ id, name }: { id: string; name: string }) {
  const info = useThreadTagInfo(id, name);
  return (
    <Tip label={info.known ? `${info.project}\n${info.status}` : "Thread not found"}>
      <span data-testid="thread-tag" data-tag-kind="thread" data-thread={id} className={tagClass(false, TAG_ACCENT.thread)}>
        <span className="truncate">{info.name}</span>
      </span>
    </Tip>
  );
}

/** A pull request, as the composer's tag: #N in its state's colour; the tooltip is its title. */
function PrChip({ slug, number }: { slug: string; number: number }) {
  const info = usePrTagInfo(slug, number);
  const ref = `${slug}#${String(number)}`;
  return (
    <Tip label={info.title ? `${info.title}\n${ref}` : ref}>
      <span data-testid="thread-tag" data-tag-kind="pr" data-slug={slug} data-number={number} data-state={info.state} className={tagClass(false, info.accent)}>
        <span className="truncate">#{number}</span>
      </span>
    </Tip>
  );
}

/** A caption part after the first: "·" then it, as the gutter's separators. */
function Dot({ children }: { children: string }) {
  return (
    <>
      <span className="sep">·</span>
      <span>{children}</span>
    </>
  );
}

/**
 * A user message: a right-aligned bubble with the composer's tags (from the composer text
 * the item carries, lib/userMessage) and citations (cite/CiteChip), attachments (images and PDFs) the text does not
 * refer to as tiles above it, and the time under it. `steer`: a message sent while the
 * turn ran (lib/threadTimeline): a smaller bubble inside the turn, "steered · +3m 10s · 14:12"
 * under it (`readAfter`: how far into the turn Claude read it, "" when unknown).
 * `delivery` (docs/notes/steer-segments.md): "queued" while Claude has not read it, "unsent"
 * when it never did: the smaller bubble with a dotted border, dimmed, captioned "queued ·
 * 14:12" or "not sent · 14:12" (DeliveryWord), wherever it sits. With `foldKey`,
 * long text folds (MessageFold), in a steer or queued message too: where it sits does not
 * make a long paste any shorter. Without, it shows whole (the search preview, the theme gallery).
 * With `foldKey` (a message in a timeline) and any text, a Copy sits just left of the time
 * or caption, shown while the bubble or that line is hovered (thread.css `.u-meta`,
 * docs/notes/copy-prompt.md); it copies the whole message as plain text (promptCopyText),
 * a folded one's too.
 */
export const UserBubble = memo(function UserBubble({
  text,
  composerText,
  attachments,
  createdAtMs,
  steer = false,
  delivery,
  readAfter = "",
  testId,
  findItem,
  foldKey,
}: {
  text: string;
  composerText: string;
  attachments: readonly string[];
  createdAtMs: number | null;
  steer?: boolean;
  delivery?: DeliveryView | undefined;
  readAfter?: string;
  testId?: string;
  /** The item id the find bar searches the bubble's text under (components/thread/find); absent: not searched (a subagent's prompt). */
  findItem?: string | undefined;
  /** The message's own id, for its fold choice (MessageFold); absent: it does not fold. */
  foldKey?: string | undefined;
}) {
  const pieces = useMemo(() => parseUserMessage(text, composerText, attachments), [text, composerText, attachments]);
  const inline = useMemo(() => inlineAttachmentPaths(pieces), [pieces]);
  const extra = attachments.filter((p) => !inline.has(p));
  const plain = useMemo(() => (foldKey === undefined ? "" : promptCopyText(pieces)), [foldKey, pieces]);
  const { copied, copy } = useCopied();
  const body = (
    <>
      {pieces.map((p, i) => {
        switch (p.kind) {
          case "text":
            return <span key={i}>{p.text}</span>;
          case "skill":
            return (
              <span key={i} data-testid="thread-tag" data-tag-kind="skill" className={tagClass(false, TAG_ACCENT.skill)}>
                <span className="truncate">/{p.name}</span>
              </span>
            );
          case "file":
            return <FileChip key={i} projectId={p.projectId} path={p.path} line={p.line} />;
          case "thread":
            return <ThreadChip key={i} id={p.id} name={p.name} />;
          case "pr":
            return <PrChip key={i} slug={p.slug} number={p.number} />;
          case "cite":
            return <CiteChip key={i} cite={p.cite} />;
          case "image":
          case "pdf":
            return <AttachmentChip key={i} name={p.name} path={p.path} pdf={p.kind === "pdf"} />;
        }
      })}
    </>
  );
  // Waiting for Claude, or never read: the queued look, wherever it sits (a steer, or the next turn's prompt to be).
  const waiting = delivery === "queued" || delivery === "unsent" ? delivery : null;
  const small = steer || waiting !== null;
  const time = sentTime(createdAtMs);
  const meta = small ? (
    <span className="text-caption inline-flex items-center gap-1.5 tabular-nums" data-testid="thread-steer-caption">
      {waiting ? <DeliveryWord delivery={waiting} /> : <span>steered</span>}
      {!waiting && readAfter && <Dot>{readAfter}</Dot>}
      {time && <Dot>{time}</Dot>}
    </span>
  ) : (
    <span className="when">{time}</span>
  );
  return (
    <div className={cn("u", small && "small", steer && "steer")} data-testid={testId ?? (steer ? "thread-steer" : "thread-user")} data-delivery={delivery}>
      {extra.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-2" aria-label="Attached files">
          {extra.map((p) => (
            <Thumbnail key={p} path={p} />
          ))}
        </ul>
      )}
      {pieces.length > 0 && (
        <div className={cn("bubble selectable", small && "max-w-[72%] rounded-lg px-3 py-1.5 text-body-sm", waiting && "queued")}>
          {foldKey === undefined ? (
            body
          ) : (
            <MessageFold foldKey={foldKey} findItem={findItem}>
              {body}
            </MessageFold>
          )}
        </div>
      )}
      {plain ? (
        <span className="u-meta">
          <GutterCopy label="Copy prompt" copied={copied} copy={copy} text={() => plain} testId="thread-copy-prompt" />
          {meta}
        </span>
      ) : (
        meta
      )}
    </div>
  );
});
