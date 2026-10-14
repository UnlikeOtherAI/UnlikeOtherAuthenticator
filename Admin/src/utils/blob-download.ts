export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function openPdfPreview(): Window {
  const preview = window.open('', '_blank');
  if (!preview) throw new Error('PDF preview was blocked');
  preview.opener = null;
  return preview;
}

export function previewPdfBlob(blob: Blob, preview = openPdfPreview()): void {
  const url = URL.createObjectURL(blob);
  preview.location.replace(url);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
