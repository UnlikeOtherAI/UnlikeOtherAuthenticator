import { useMemo, useState } from 'react';

type AutocompleteOption = {
  label: string;
  value: string;
  meta?: string;
};

type AutocompleteSelectProps = {
  label: string;
  options: AutocompleteOption[];
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
};

export function AutocompleteSelect({ label, onChange, options, placeholder, value }: AutocompleteSelectProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return options.slice(0, 8);
    }

    return options.filter((option) => option.label.toLowerCase().includes(normalized)).slice(0, 8);
  }, [options, query]);

  return (
    <label className="relative block w-72 max-w-full">
      <span className="mb-1.5 block text-sm font-medium text-gray-700">{label}</span>
      <input
        className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100"
        value={isOpen ? query : selected?.label ?? ''}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          setQuery('');
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setIsOpen(false);
          }
        }}
      />
      {isOpen ? (
        <div className="absolute left-0 right-0 top-[4.25rem] z-30 max-h-72 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-xl">
          <button className="block w-full px-3 py-2 text-left text-sm text-gray-500 transition-colors hover:bg-indigo-50" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange('all'); setIsOpen(false); }}>
            All organisations
          </button>
          {filteredOptions.map((option) => (
            <button
              key={option.value}
              className="block w-full px-3 py-2 text-left transition-colors hover:bg-indigo-50"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              <span className="block text-sm font-medium text-gray-900">{option.label}</span>
              {option.meta ? <span className="block text-xs text-gray-400">{option.meta}</span> : null}
            </button>
          ))}
          {filteredOptions.length === 0 ? <p className="px-3 py-3 text-sm text-gray-400">No organisations found.</p> : null}
        </div>
      ) : null}
    </label>
  );
}
