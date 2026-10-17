import { memo, useMemo, useState } from "react";
import { ArrowDown, FileText, ImageIcon } from "lucide-react";
import { AttachmentLightbox } from "@/components/compose/AttachmentLightbox";
import { ChipFace, PdfTile } from "@/components/compose/attachmentFaces";
import { TAG_ACCENT, tagClass } from "@/components/compose/tagStyle";
import { Tip } from "@/components/ui/tooltip";
import { pageCount, previewLabel } from "@/lib/compose";
import { formatAttachmentSize, kindFromName, middleTruncate, stagedPdfPages, tagLabel } from "@/lib/prompt";
import { inlineAttachmentPaths, parseUserMessage } from "@/lib/userMessage";
import { cn } from "@/lib/utils";
import { type PdfSummary, useAttachment, usePdfSummary } from "@/stores/attachments";
import { useProjectsStore } from "@/stores/projects";

/** The image chip's accent: green, the success token. */
const IMAGE_ACCENT = "[--chip-accent:var(--success)]";

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
 * PDF's first page) and name, and a PDF's page count (its size in the tooltip); a click
 * previews it. A path the daemon no longer has shows dashed and does nothing.
 */
function AttachmentChip({ name, path, pdf }: { name: string; path: string; pdf: boolean }) {
  const { url, file } = useAttachment(path);
  const summary = usePdfSummary(pdf ? path : "");
  const [open, setOpen] = useState(false);
  const size = file ? formatAttachmentSize(file.size) : "";
  const count = pdf ? sentPages(path, summary) : null;
  const pages = count === null ? "" : pageCount(count);
  return (
    <>
      <Tip label={pages && size ? size : null}>
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
    <li className="size-16 overflow-hidden rounded-lg border bg-muted/40" data-testid="thread-attachment" data-kind={pdf ? "pdf" : "image"} data-pages={pages ?? undefined}>
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
        <span className="flex size-full items-center justify-center text-muted-foreground">
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

function FileChip({ projectId, path }: { projectId: string; path: string }) {
  const project = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  return (
    <Tip label={`${project}/${path}`}>
      <span data-testid="thread-tag" data-tag-kind="file" data-path={path} className={tagClass(false, TAG_ACCENT.file)}>
        <span className="truncate">{tagLabel({ tagKind: "file", projectId, path })}</span>
      </span>
    </Tip>
  );
}

/** "14:02" (today's), else the date too. */
function timeOf(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * A user message: a right-aligned bubble with the composer's tags (from the composer text
 * the item carries, lib/userMessage), attachments (images and PDFs) the text does not
 * refer to as tiles above it, and the time under it. `steer`: a message sent while the
 * turn ran (lib/threadTimeline): a smaller bubble inside the turn, "sent mid-turn · 14:12"
 * under it.
 */
export const UserBubble = memo(function UserBubble({
  text,
  composerText,
  attachments,
  createdAtMs,
  steer = false,
}: {
  text: string;
  composerText: string;
  attachments: readonly string[];
  createdAtMs: number | null;
  steer?: boolean;
}) {
  const pieces = useMemo(() => parseUserMessage(text, composerText, attachments), [text, composerText, attachments]);
  const inline = useMemo(() => inlineAttachmentPaths(pieces), [pieces]);
  const extra = attachments.filter((p) => !inline.has(p));
  return (
    <div className={cn("u", steer && "steer")} data-testid={steer ? "thread-steer" : "thread-user"}>
      {extra.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-2" aria-label="Attached files">
          {extra.map((p) => (
            <Thumbnail key={p} path={p} />
          ))}
        </ul>
      )}
      {pieces.length > 0 && (
        <div className={cn("bubble selectable", steer && "max-w-[72%] rounded-lg px-3 py-1.5 text-body-sm")}>
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
                return <FileChip key={i} projectId={p.projectId} path={p.path} />;
              case "image":
              case "pdf":
                return <AttachmentChip key={i} name={p.name} path={p.path} pdf={p.kind === "pdf"} />;
            }
          })}
        </div>
      )}
      {steer ? (
        <span className="text-caption inline-flex items-center gap-1 tabular-nums" data-testid="thread-steer-caption">
          <ArrowDown className="size-3" aria-hidden />
          {["sent mid-turn", timeOf(createdAtMs)].filter(Boolean).join(" · ")}
        </span>
      ) : (
        <span className="when">{timeOf(createdAtMs)}</span>
      )}
    </div>
  );
});
