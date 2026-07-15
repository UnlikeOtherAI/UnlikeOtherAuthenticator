export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function previewPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const preview = window.open(url, '_blank', 'noopener,noreferrer');
  if (!preview) {
    URL.revokeObjectURL(url);
    throw new Error('PDF preview was blocked');
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
