import { useState, type KeyboardEvent } from 'react';

import { Icon } from '../icons/Icon';
import { TextField } from '../ui/FormFields';

export type StringListTone = 'indigo' | 'emerald' | 'blue';

const TONE_CLASSES: Record<StringListTone, { chip: string; remove: string }> = {
  indigo: {
    chip: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    remove: 'text-indigo-400 hover:text-indigo-700',
  },
  emerald: {
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    remove: 'text-emerald-400 hover:text-emerald-700',
  },
  blue: {
    chip: 'border-blue-200 bg-blue-50 text-blue-700',
    remove: 'text-blue-400 hover:text-blue-700',
  },
};

/**
 * Generic controlled editor for a list of strings. Renders the current values as removable chips
 * plus an input that adds a value on Enter / comma / blur, and removes the last value on Backspace
 * when the input is empty.
 *
 * This is the single chip-list implementation reused for every "list of allowed X" field
 * (allowed email domains, allowed individual emails, allowed redirect URLs) across the domain,
 * organisation, and team scopes. Per-field behaviour (normalisation, validation, placeholder,
 * colour) is supplied via props rather than duplicated.
 */
export function StringListField({
  value,
  onChange,
  disabled,
  placeholder,
  emptyLabel,
  tone = 'indigo',
  normalize = (raw) => raw.trim(),
  validate,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder: string;
  emptyLabel: string;
  tone?: StringListTone;
  normalize?: (raw: string) => string;
  validate?: (entry: string) => boolean;
}) {
  const [draft, setDraft] = useState('');
  const toneClasses = TONE_CLASSES[tone];

  function addDraft() {
    const entry = normalize(draft);
    setDraft('');
    if (!entry || value.includes(entry)) return;
    if (validate && !validate(entry)) return;
    onChange([...value, entry]);
  }

  function remove(item: string) {
    onChange(value.filter((entry) => entry !== item));
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
          {value.map((item) => (
            <span
              key={item}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${toneClasses.chip}`}
            >
              {item}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${item}`}
                  onClick={() => remove(item)}
                  className={toneClasses.remove}
                >
                  <Icon name="close" className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">{emptyLabel}</p>
      )}
      {!disabled ? (
        <TextField
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addDraft}
        />
      ) : null}
    </div>
  );
}
