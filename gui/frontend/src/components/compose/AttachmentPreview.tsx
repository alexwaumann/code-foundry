import { formatAttachmentSize } from "@/lib/prompt";
import { closePreview, useComposeStore } from "@/stores/compose";
import { AttachmentLightbox } from "./AttachmentLightbox";

/**
 * The lightbox for a draft attachment (opened from its tile or an inline chip; see
 * AttachmentLightbox). Focus goes back to where it was opened from.
 */
export function AttachmentPreview({ draftKey }: { draftKey: string }) {
  const preview = useComposeStore((s) => (s.preview?.draftKey === draftKey ? s.preview : null));
  const att = useComposeStore((s) => (preview ? s.drafts[draftKey]?.attachments.find((a) => a.id === preview.id) : undefined));
  return (
    <AttachmentLightbox
      open={preview?.open === true && att !== undefined}
      onClose={closePreview}
      testId="attachment-preview"
      attachmentId={att?.id}
      kind={att?.kind}
      name={att?.file.name ?? ""}
      size={att ? formatAttachmentSize(att.file.size) : ""}
      pages={att?.pages ?? null}
      url={att?.url ?? null}
      file={att?.file ?? null}
      onCloseAutoFocus={(e) => {
        const el = preview?.returnFocus;
        if (!el?.isConnected) return;
        e.preventDefault();
        el.focus();
      }}
    />
  );
}
