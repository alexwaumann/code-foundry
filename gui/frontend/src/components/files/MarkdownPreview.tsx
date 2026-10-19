import { useEffect, useMemo, useState } from "react";
import { ImageIcon } from "lucide-react";
import { readFile, type FileReadView } from "@/api/files";
import { Markdown, type MarkdownExtras } from "@/components/pr/Markdown";
import { CodeBlock } from "@/components/thread/Code";
import { PathPlaceContext } from "@/components/thread/context";
import { PathChip } from "@/components/thread/PathChip";
import { Tip } from "@/components/ui/tooltip";
import { useBlobSrc } from "./useBlobSrc";
import "@/components/thread/thread.css";
import "@/components/thread/codeActions.css";
import "./files.css";

/**
 * An image in a rendered markdown file with a local path: read through ReadFile against
 * the file's directory and shown from an object URL; a chip with the path while it loads,
 * or when it is missing, not an image, or too large to come back whole.
 */
function LocalImage({ dir, src, alt }: { dir: string; src: string; alt: string }) {
  const [file, setFile] = useState<FileReadView | null | "failed">(null);
  useEffect(() => {
    const ctl = new AbortController();
    readFile(dir, decodeURI(src), undefined, ctl.signal)
      .then((f) => {
        setFile(f.image && !f.truncated ? f : "failed");
      })
      .catch(() => {
        if (!ctl.signal.aborted) setFile("failed");
      });
    return () => {
      ctl.abort();
    };
  }, [dir, src]);
  const image = file !== null && file !== "failed" ? file : null;
  const imgRef = useBlobSrc(image?.image ?? null, image?.mime ?? "");
  if (image) return <img ref={imgRef} alt={alt} data-testid="md-local-image" />;
  return (
    <Tip label={alt ? src : null}>
      <span className="inline-flex items-center gap-1 rounded-sm border px-1.5 text-caption">
        <ImageIcon className="size-3" aria-hidden />
        {file === null ? "Loading image…" : alt || src}
      </span>
    </Tip>
  );
}

/**
 * A markdown file rendered: the shared renderer (components/pr/Markdown) with the thread's
 * highlighted code blocks and framed tables, the file's HTML allowed (READMEs use it,
 * sanitized as GitHub bodies are), and relative images read from disk. Links open in the
 * browser; file paths are chips, relative ones resolved against `base` (the thread checkout
 * the tab was opened from), not the file's own folder. A reading column with padding,
 * headings on the type roles (files.css).
 */
export function MarkdownPreview({ text, dir, project, base }: { text: string; dir: string; project: string; base: string }) {
  const place = useMemo(() => ({ project, base }), [project, base]);
  const extras = useMemo<MarkdownExtras>(
    () => ({
      code: (lang, code) => <CodeBlock lang={lang} code={code} />,
      image: (src, alt) => <LocalImage dir={dir} src={src} alt={alt} />,
      pathChip: (m) => <PathChip match={m} />,
      table: (rows) => (
        <div className="cf-table">
          <table>{rows}</table>
        </div>
      ),
    }),
    [dir],
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="file-markdown">
      <div className="cf-thread cf-file-md mx-auto max-w-3xl px-5 py-4">
        <PathPlaceContext.Provider value={place}>
          <Markdown extras={extras}>{text}</Markdown>
        </PathPlaceContext.Provider>
      </div>
    </div>
  );
}
