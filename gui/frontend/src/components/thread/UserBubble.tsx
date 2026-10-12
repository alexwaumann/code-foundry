import { memo, useMemo, useState } from "react";
import { ImageIcon, X } from "lucide-react";
import { TAG_ACCENT, tagClass } from "@/components/compose/tagStyle";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { middleTruncate, tagLabel } from "@/lib/prompt";
import { inlineImagePaths, parseUserMessage } from "@/lib/userMessage";
import { useAttachmentUrl } from "@/stores/attachmentImages";
import { useReposStore } from "@/stores/repos";

/** The image chip's accent (green, the sketch's), light / dark. */
const IMAGE_ACCENT = "[--chip-accent:oklch(0.62_0.13_152)] dark:[--chip-accent:oklch(0.76_0.12_152)]";

/** The lightbox for an image the message sent. */
function ImagePreview({ open, onClose, url, name }: { open: boolean; onClose: () => void; url: string; name: string }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        data-testid="thread-image-preview"
        overlayClassName="bg-black/80"
        className="top-1/2 flex w-auto max-w-[calc(90vw/var(--cf-zoom))] min-w-72 -translate-y-1/2 flex-col overflow-hidden bg-popover/95 p-0"
      >
        <div className="flex min-w-0 items-center gap-3 border-b py-2 pr-2 pl-4">
          <DialogTitle className="min-w-0 truncate">{name}</DialogTitle>
          <button
            type="button"
            aria-label="Close preview"
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <img src={url} alt={name} className="mx-auto block h-auto max-h-[calc(85vh/var(--cf-zoom))] w-auto max-w-[calc(90vw/var(--cf-zoom))] object-contain" />
      </DialogContent>
    </Dialog>
  );
}

/** An image the message sent, inline as the composer's chip: thumbnail and name; a click previews it. */
function ImageChip({ name, path }: { name: string; path: string }) {
  const { url } = useAttachmentUrl(path);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="thread-tag"
        data-tag-kind="image"
        aria-label={`Image ${name}`}
        className={tagClass(false, `${IMAGE_ACCENT} ${url ? "cursor-pointer" : "border-dashed"}`)}
        disabled={!url}
        onClick={() => {
          setOpen(true);
        }}
      >
        {url ? <img src={url} alt="" className="size-[1.17em] shrink-0 rounded-sm object-cover" /> : <ImageIcon aria-hidden className="size-[1.17em] shrink-0" />}
        <span className="truncate">{middleTruncate(name)}</span>
      </button>
      {url && (
        <ImagePreview
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          url={url}
          name={name}
        />
      )}
    </>
  );
}

/** An attachment the text does not refer to: a thumbnail above the bubble. */
function Thumbnail({ path }: { path: string }) {
  const { url } = useAttachmentUrl(path);
  const [open, setOpen] = useState(false);
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <li className="size-16 overflow-hidden rounded-lg border bg-muted/40" data-testid="thread-attachment">
      {url ? (
        <button
          type="button"
          className="block size-full cursor-pointer"
          aria-label={`Preview ${name}`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <img src={url} alt={name} className="size-full object-cover" />
        </button>
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <ImageIcon className="size-4" aria-hidden />
        </span>
      )}
      {url && (
        <ImagePreview
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          url={url}
          name={name}
        />
      )}
    </li>
  );
}

function FileChip({ repoId, path }: { repoId: string; path: string }) {
  const project = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  return (
    <span data-testid="thread-tag" data-tag-kind="file" data-path={path} title={`${project}/${path}`} className={tagClass(false, TAG_ACCENT.file)}>
      <span className="truncate">{tagLabel({ tagKind: "file", repoId, path })}</span>
    </span>
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
 * A user message: a right-aligned bubble with the composer's tags read back from the sent
 * text (lib/userMessage), attachments the text does not refer to as thumbnails above it,
 * and the time under it.
 */
export const UserBubble = memo(function UserBubble({ text, attachments, createdAtMs }: { text: string; attachments: readonly string[]; createdAtMs: number | null }) {
  const pieces = useMemo(() => parseUserMessage(text), [text]);
  const inline = useMemo(() => inlineImagePaths(pieces), [pieces]);
  const extra = attachments.filter((p) => !inline.has(p));
  return (
    <div className="u" data-testid="thread-user">
      {extra.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-2" aria-label="Attached images">
          {extra.map((p) => (
            <Thumbnail key={p} path={p} />
          ))}
        </ul>
      )}
      {text && (
        <div className="bubble selectable">
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
                return <FileChip key={i} repoId={p.repoId} path={p.path} />;
              case "image":
                return <ImageChip key={i} name={p.name} path={p.path} />;
            }
          })}
        </div>
      )}
      <span className="when">{timeOf(createdAtMs)}</span>
    </div>
  );
});
