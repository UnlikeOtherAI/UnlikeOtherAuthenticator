import { useState } from 'react';
import { useAccessTranslation } from '../../hooks/use-access-translation.js';
import { Button } from '../ui/Button.js';

export function CopyValue({ label, value }: { label: string; value: string }) {
  const t = useAccessTranslation();
  const [status, setStatus] = useState<'copy' | 'copied' | 'copyError'>('copy');
  return <div className="space-y-1">
    <p className="text-sm font-medium">{label}</p>
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-[var(--uoa-radius-input)] bg-[var(--uoa-color-bg)] p-3 text-sm">{value}</code>
      <Button className="w-auto! shrink-0" variant="secondary" type="button" onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setStatus('copied'), () => setStatus('copyError'));
      }}>{t(status === 'copyError' ? 'copy' : status)}</Button>
    </div>
    {status === 'copyError' && <p role="status" className="text-sm">{t(status)}</p>}
  </div>;
}
