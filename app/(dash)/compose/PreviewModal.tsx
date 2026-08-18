"use client";

// ONE honest preview of the member card.
//
// This used to be "Preview · mobile & web", rendering THE SAME <PostPreview>
// in both panes with only the surrounding frame differing — so the web pane
// was decoration, and a preview that lies is worse than one pane that tells
// the truth (ENG-558, decision (b)). The switch is replaced by a sentence
// saying in words what web actually does differently; a third faithful copy of
// the member card was rejected as a standing maintenance tax.
import { useEffect } from "react";
import PostPreview, { type PostPreviewData } from "./PostPreview";
import styles from "./compose.module.css";

export default function PreviewModal({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: PostPreviewData;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.modalRoot}
      role="dialog"
      aria-modal="true"
      aria-label="Post preview"
      data-testid="preview-modal"
    >
      <div className={styles.modalBackdrop} onClick={onClose} />
      <div className={styles.modalPanel} data-testid="preview-panel">
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>Preview</h2>
          <button
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>

        {/* Measurement is owned by the always-mounted sidebar preview; this
            one only displays what was measured. */}
        <PostPreview data={data} />
      </div>
    </div>
  );
}
