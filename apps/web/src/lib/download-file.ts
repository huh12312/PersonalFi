// SPDX-License-Identifier: MIT

/**
 * Triggers a browser "Save As" for in-memory text — used for the transaction
 * CSV export, whose body already arrived as a string in
 * `exportTransactions`'s response (RFC 4180, `text/csv`). No `<a href>` to a
 * server URL: the export needs a step-up-gated, credentialed `fetch` first
 * (`lib/step-up.ts`), so the browser can never be handed a bare link to the
 * resource directly.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}
