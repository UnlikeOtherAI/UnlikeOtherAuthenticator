import React, { useEffect, useId, useRef, useState } from 'react';

export type OrganisationDestinationOption = {
  value: string;
  label: string;
};

/**
 * A small, keyboard-accessible listbox for the hosted chooser. Native selects cannot match the
 * popup's themed menu treatment, so this control owns the same browser-only interaction while
 * leaving the allowed destination values entirely to its caller.
 */
export function OrganisationDestinationDropdown(props: {
  id: string;
  labelId: string;
  options: OrganisationDestinationOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [isOpen, setIsOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selectedOption = props.options[selectedIndex];

  useEffect(() => {
    if (!isOpen) return;

    function closeWhenOutside(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    }

    document.addEventListener('pointerdown', closeWhenOutside);
    return () => document.removeEventListener('pointerdown', closeWhenOutside);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, isOpen]);

  function openAt(index: number): void {
    setActiveIndex(index);
    setIsOpen(true);
  }

  function moveActive(delta: number): void {
    const optionCount = props.options.length;
    if (optionCount === 0) return;
    setActiveIndex((index) => (index + delta + optionCount) % optionCount);
  }

  function choose(index: number): void {
    const option = props.options[index];
    if (!option) return;
    props.onChange(option.value);
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (props.disabled || props.options.length === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        openAt((selectedIndex + 1) % props.options.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        openAt((selectedIndex - 1 + props.options.length) % props.options.length);
        break;
      case 'Home':
        event.preventDefault();
        openAt(0);
        break;
      case 'End':
        event.preventDefault();
        openAt(props.options.length - 1);
        break;
      case 'Escape':
        setIsOpen(false);
        break;
      default:
        break;
    }
  }

  function handleOptionKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(props.options.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
        break;
      case 'Tab':
        setIsOpen(false);
        break;
      default:
        setActiveIndex(index);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative mt-1">
      <button
        ref={triggerRef}
        id={props.id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-labelledby={props.labelId}
        disabled={props.disabled}
        onClick={() => (isOpen ? setIsOpen(false) : openAt(selectedIndex))}
        onKeyDown={handleTriggerKeyDown}
        className="flex w-full items-center justify-between rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] px-3 py-2 text-left text-sm text-[var(--uoa-color-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span>{selectedOption?.label ?? ''}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0">
          <path
            d="m5 7.5 5 5 5-5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      </button>

      {isOpen ? (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={props.labelId}
          className="absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] p-1 shadow-lg"
        >
          {props.options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              onClick={() => choose(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              className="flex w-full rounded-[calc(var(--uoa-radius-input)-4px)] px-3 py-2 text-left text-sm text-[var(--uoa-color-text)] hover:bg-[var(--uoa-color-bg)] focus:bg-[var(--uoa-color-bg)] focus:outline-none"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
