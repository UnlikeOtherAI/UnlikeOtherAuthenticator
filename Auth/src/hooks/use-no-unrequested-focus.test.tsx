// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNoUnrequestedFocus } from './use-no-unrequested-focus.js';

function Harness(): React.JSX.Element {
  const ref = useNoUnrequestedFocus<HTMLFormElement>();
  return (
    <form ref={ref}>
      <input name="email" type="email" />
      <button type="submit">Sign in</button>
    </form>
  );
}

let container: HTMLDivElement;
let root: Root | null;

function submitButton(): HTMLButtonElement {
  const button = container.querySelector('button[type="submit"]');
  if (!button) throw new Error('missing submit button');
  return button as HTMLButtonElement;
}

function emailInput(): HTMLInputElement {
  const input = container.querySelector('input[name="email"]');
  if (!input) throw new Error('missing email input');
  return input as HTMLInputElement;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
});

function mount(): void {
  const created = createRoot(container);
  root = created;
  act(() => created.render(<Harness />));
}

describe('useNoUnrequestedFocus', () => {
  it('drops focus the user did not ask for', () => {
    mount();

    emailInput().focus();

    expect(document.activeElement).not.toBe(emailInput());
  });

  it('drops focus that landed on the server-rendered field before hydration', () => {
    container.innerHTML = renderToString(<Harness />);
    emailInput().focus();
    expect(document.activeElement).toBe(emailInput());

    act(() => {
      root = hydrateRoot(container, <Harness />);
    });

    expect(document.activeElement).not.toBe(emailInput());
  });

  it('keeps focus that follows a tap', () => {
    mount();

    window.dispatchEvent(new Event('pointerdown'));
    emailInput().focus();

    expect(document.activeElement).toBe(emailInput());
  });

  it('keeps focus that follows a key press', () => {
    mount();

    window.dispatchEvent(new Event('keydown'));
    emailInput().focus();

    expect(document.activeElement).toBe(emailInput());
  });

  // Assistive tech moves focus with no preceding pointer or key event, so "no gesture yet"
  // cannot mean "nobody asked for this" forever. After the arrival window the focus is theirs.
  it('leaves focus alone once the arrival window has passed', () => {
    vi.useFakeTimers();
    try {
      mount();
      vi.advanceTimersByTime(1001);

      emailInput().focus();

      expect(document.activeElement).toBe(emailInput());
    } finally {
      vi.useRealTimers();
    }
  });

  it('never blurs a control that raises no keyboard', () => {
    mount();

    submitButton().focus();

    expect(document.activeElement).toBe(submitButton());
  });
});
