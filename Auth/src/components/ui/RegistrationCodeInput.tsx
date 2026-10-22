import React, { useId, useRef } from 'react';

export function cleanRegistrationCode(value: string): string {
  return value.toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '').slice(0, 6);
}

export function RegistrationCodeInput(props: {
  value: string; onChange: (value: string) => void; onComplete: (value: string) => void;
  disabled?: boolean; label: string; errorId?: string;
}): React.JSX.Element {
  const labelId = useId();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length: 6 }, (_, index) => props.value[index]?.trim() ?? '');

  function setCharacters(next: string[], focus: number) {
    const value = next.map(char => char || ' ').join('');
    props.onChange(value);
    inputs.current[Math.max(0, Math.min(focus, 5))]?.focus();
    if (next.every(Boolean)) props.onComplete(value);
  }

  function change(index: number, raw: string) {
    const clean = cleanRegistrationCode(raw);
    if (clean.length > 1) {
      const next = Array.from({ length: 6 }, (_, offset) => clean[offset] ?? '');
      setCharacters(next, Math.min(clean.length, 5));
      return;
    }
    const next = [...chars];
    next[index] = clean;
    setCharacters(next, clean ? index + 1 : index);
  }

  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" disabled={props.disabled} aria-describedby={props.errorId}>
      <legend id={labelId} className="mb-3 text-sm font-medium text-[var(--uoa-color-text)]">{props.label}</legend>
      <div className="flex justify-center gap-2" role="group" aria-labelledby={labelId}>
        {chars.map((char, index) => (
          <input
            key={index}
            ref={element => { inputs.current[index] = element; }}
            aria-label={`${props.label} ${index + 1} / 6`}
            aria-invalid={Boolean(props.errorId)}
            aria-describedby={props.errorId}
            name={index === 0 ? 'one-time-code' : `code-${index + 1}`}
            type="text" inputMode="text" autoCapitalize="characters" spellCheck={false}
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            value={char}
            className="h-14 w-0 min-w-0 max-w-12 flex-1 rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] text-center text-2xl font-bold uppercase text-[var(--uoa-color-text)] outline-none focus:border-[var(--uoa-color-primary)] focus:ring-2 focus:ring-[var(--uoa-color-primary)] disabled:opacity-60"
            onChange={event => change(index, event.currentTarget.value)}
            onFocus={event => event.currentTarget.select()}
            onPaste={event => {
              event.preventDefault();
              change(index, event.clipboardData.getData('text'));
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                inputs.current[Math.max(0, Math.min(5, index + (event.key === 'ArrowLeft' ? -1 : 1)))]?.focus();
              } else if (event.key === 'Backspace') {
                event.preventDefault();
                const target = chars[index] ? index : Math.max(0, index - 1);
                const next = [...chars]; next[target] = '';
                setCharacters(next, target);
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault(); inputs.current[event.key === 'Home' ? 0 : 5]?.focus();
              }
            }}
          />
        ))}
      </div>
    </fieldset>
  );
}
