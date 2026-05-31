import { useState, type KeyboardEvent } from 'react';

import { Icon } from '../icons/Icon';
import { TextField } from '../ui/FormFields';

function normalizeEntry(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

/**
 * Controlled editor for an allowed-login-email-domains list. Renders the current domains as
 * removable chips plus an input that adds a domain on Enter / comma / blur. Empty list means
 * "no restriction".
 */
export function AllowedEmailDomainsField({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');

  function addDraft() {
    const entry = normalizeEntry(draft);
    setDraft('');
    if (!entry || value.includes(entry)) return;
    onChange([...value, entry]);
  }

  function remove(domain: string) {
    onChange(value.filter((item) => item !== domain));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addDraft();
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      remove(value[value.length - 1]);
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((domain) => (
            <span
              key={domain}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700"
            >
              {domain}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${domain}`}
                  onClick={() => remove(domain)}
                  className="text-indigo-400 hover:text-indigo-700"
                >
                  <Icon name="close" className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">No restriction — anyone can sign in to this scope.</p>
      )}
      {!disabled ? (
        <TextField
          value={draft}
          placeholder="acme.com — press Enter to add"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addDraft}
        />
      ) : null}
    </div>
  );
}
