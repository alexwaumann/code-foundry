import { useEffect } from "react";
import { HtmlFrame } from "@/components/files/HtmlFrame";
import { usePreviewGrant } from "@/components/files/previewGrant";
import { pageStoragePath } from "@/components/files/usePageThread";
import type { PageBridge } from "@/stores/bridgeHost";
import { dirPart, fileName } from "@/lib/filePath";
import { usePageCheckStage, type PageCheckJob } from "./pageCheckRunner";

/**
 * A page check's card frame (docs/notes/page-self-check.md): the page in the frame a thread's
 * card uses (HtmlFrame), acting for the check's thread with its file's storage, at the top of
 * the window, as tall as the page asks for (else the card's default). The frame's events go
 * to the check; nothing here is ever on a display.
 */
export function PageCheckStage() {
  const job = usePageCheckStage((s) => s.job);
  const height = usePageCheckStage((s) => s.height);
  if (!job) return null;
  return <CheckFrame key={job.id + "\u0000" + job.path} job={job} height={height} />;
}

function CheckFrame({ job, height }: { job: PageCheckJob; height: number }) {
  const grant = usePreviewGrant(dirPart(job.path), job.path);
  // The clock runs from the frame's start (start is once only, whatever StrictMode does).
  useEffect(() => {
    job.check.start();
  }, [job]);
  const failed = !grant.loading && !grant.preview;
  useEffect(() => {
    if (failed) job.check.fail(`Could not render this page${grant.error ? `: ${grant.error}` : ""}`);
  }, [failed, grant.error, job]);
  const preview = grant.preview;
  if (!preview) return null;
  const access = preview.page;
  const thread = job.threadId || null;
  const page: PageBridge | undefined = !thread && access?.consent === "allowed" ? { kind: "allowed", path: access.path } : undefined;
  return (
    <div className="w-screen bg-cf-surface" data-testid="page-check-stage">
      <HtmlFrame
        url={preview.url}
        name={fileName(job.path)}
        thread={thread}
        storagePath={thread ? pageStoragePath(access) : null}
        page={page}
        pagePath={job.path}
        check={job.check}
        style={{ height }}
        testId="page-check-frame"
      />
    </div>
  );
}
