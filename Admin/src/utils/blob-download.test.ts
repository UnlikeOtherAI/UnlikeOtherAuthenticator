// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { openPdfPreview, previewPdfBlob } from './blob-download';
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('detaches the opener before protected bytes arrive and retains the URL for viewing', () => {
  vi.useFakeTimers();
  const preview = { opener: window, location: { replace: vi.fn() } };
  vi.spyOn(window, 'open').mockReturnValue(preview as unknown as Window);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const opened = openPdfPreview();
  expect(preview.opener).toBeNull();
  previewPdfBlob(new Blob(['pdf'], { type: 'application/pdf' }), opened);
  expect(preview.location.replace).toHaveBeenCalledWith('blob:synthetic');
  expect(revoke).not.toHaveBeenCalled();
});
it('reports a blocked popup before fetching a PDF', () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  expect(openPdfPreview).toThrow('PDF preview was blocked');
});
