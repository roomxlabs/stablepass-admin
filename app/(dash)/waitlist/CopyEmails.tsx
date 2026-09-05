"use client";

import { useState } from "react";

/**
 * Copies the shown addresses to the clipboard, comma-separated, for pasting
 * into the BCC field of a launch email.
 *
 * A client component only because the clipboard is a browser API; the list it
 * copies is built on the server (`emailsFor`) and passed in, so the string is
 * never assembled twice or allowed to drift from what the table renders.
 */
export default function CopyEmails({ emails, count }: { emails: string; count: number }) {
  const [copied, setCopied] = useState(false);

  if (count === 0) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(emails);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure origin, permissions policy).
      // Say so rather than showing a success state that did not happen.
      setCopied(false);
      window.prompt("Copy the addresses:", emails);
    }
  }

  return (
    <button type="button" className="btn" onClick={copy}>
      {copied ? "Copied" : `Copy ${count} email${count === 1 ? "" : "s"}`}
    </button>
  );
}
