import { useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { CreatedBillingAppKey } from '../../schemas/billing';

export function BillingKeyRevealDialog({
  createdKey,
  onClose,
}: {
  createdKey: CreatedBillingAppKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey.key);
    setCopied(true);
  }

  return (
    <Modal
      isOpen={createdKey !== null}
      onClose={onClose}
      title="Product billing app key issued"
      widthClassName="max-w-2xl"
      footer={
        <Button variant="primary" onClick={onClose}>
          I have stored this key
        </Button>
      }
    >
      {createdKey ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            The plaintext is shown once. Put it in that product’s secret store now; UOA stores only
            a digest and cannot reveal it later.
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
              X-UOA-App-Key
            </p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-gray-950 px-3 py-3 text-xs text-green-300">
                {createdKey.key}
              </code>
              <Button icon="copy" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
          <dl className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-gray-400">Product key prefix</dt>
              <dd className="mt-1 font-mono text-gray-700">{createdKey.key_prefix}</dd>
            </div>
            <div>
              <dt className="text-gray-400">Actor signing key</dt>
              <dd className="mt-1 font-mono text-gray-700">{createdKey.actor_key_id}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </Modal>
  );
}
