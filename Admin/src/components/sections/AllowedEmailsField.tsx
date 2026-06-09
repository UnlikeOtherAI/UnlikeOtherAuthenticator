import { useState, type KeyboardEvent } from 'react';

import { Icon } from '../icons/Icon';
import { TextField } from '../ui/FormFields';

function normalizeEntry(raw: string): string {
  return raw.trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

/**
 * Controlled editor for exact allowed-login-email entries. Renders the current emails as removable
 * chips plus an input that adds an email on Enter / comma / blur.
 */
export function AllowedEmailsField({
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
    if (!entry || !looksLikeEmail(entry) || value.includes(entry)) return;
    onChange([...value, entry]);
  }

  function remove(email: string) {
    onChange(value.filter((item) => item !== email));
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
          {value.map((email) => (
            <span
              key={email}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
            >
              {email}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${email}`}
                  onClick={() => remove(email)}
                  className="text-emerald-400 hover:text-emerald-700"
                >
                  <Icon name="close" className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">No individual email entries.</p>
      )}
      {!disabled ? (
        <TextField
          value={draft}
          placeholder="person@acme.com — press Enter to add"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addDraft}
        />
      ) : null}
    </div>
  );
}
