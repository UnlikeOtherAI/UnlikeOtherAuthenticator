import { useState } from 'react';

export function CopyableIdentifier({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-gray-500">
      <span className="shrink-0 font-medium">{label}</span>
      <code className="min-w-0 truncate font-mono text-gray-600" title={value}>
        {value}
      </code>
      <button
        aria-label={`Copy ${label.toLowerCase()} ID`}
        className="shrink-0 rounded px-1 py-0.5 font-medium text-blue-700 hover:bg-blue-50"
        type="button"
        onClick={() => void copy()}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
