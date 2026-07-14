"use client";

// Full "Preview on mobile & web" — the same post rendered in two device
// frames so the operator sees both surfaces before publishing.
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
    <div className={styles.modalRoot} role="dialog" aria-modal="true" aria-label="Post preview" data-testid="preview-modal">
      <div className={styles.modalBackdrop} onClick={onClose} />
      <div className={styles.modalPanel}>
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>Preview · mobile &amp; web</h2>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close preview">
            ×
          </button>
        </div>

        <div className={styles.frames}>
          <div>
            <div className={styles.frameLabel}>Mobile</div>
            <div className={styles.phone}>
              <div className={styles.phoneScreen}>
                <PostPreview data={data} />
              </div>
            </div>
          </div>

          <div>
            <div className={styles.frameLabel}>Web</div>
            <div className={styles.web}>
              <div className={styles.webChrome}>
                <div className={styles.webDots}>
                  <span />
                  <span />
                  <span />
                </div>
                <div className={styles.webUrl}>app.stablepass.co</div>
              </div>
              <div className={styles.webScreen}>
                <PostPreview data={data} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
