import { useEffect, useState } from 'react';

import { AllowedEmailDomainsField } from './AllowedEmailDomainsField';
import { Button } from '../ui/Button';

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Card that edits and saves an allowed-login-email-domains list for one scope (organisation or
 * team). Login is blocked for users whose email domain is not in the list (SUPERUSER bypasses).
 */
export function LoginRestrictionSection({
  title,
  description,
  value,
  onSave,
}: {
  title: string;
  description: string;
  value: string[];
  onSave: (next: string[]) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string[]>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = !sameList(draft, value);

  async function save() {
    setSaving(true);
    setError(false);
    try {
      await onSave(draft);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="mt-0.5 text-xs text-gray-500">{description}</p>
        </div>
        <Button
          icon="check"
          variant="primary"
          size="sm"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <AllowedEmailDomainsField value={draft} onChange={setDraft} />
      {error ? <p className="mt-2 text-xs text-red-600">Could not save. Check the domains and try again.</p> : null}
    </section>
  );
}
