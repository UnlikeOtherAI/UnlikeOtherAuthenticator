// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrganisationDestinationDropdown } from './OrganisationDestinationDropdown.js';

let container: HTMLDivElement;
let root: Root | null;

function Harness(): React.JSX.Element {
  const [value, setValue] = useState('__new_organisation__');

  return (
    <div>
      <label id="organisation-label" htmlFor="organisation-destination">
        Organisation
      </label>
      <OrganisationDestinationDropdown
        id="organisation-destination"
        labelId="organisation-label"
        options={[
          { value: '__new_organisation__', label: 'Create a new organisation' },
          { value: 'org-acme', label: 'Acme' },
          { value: 'org-globex', label: 'Globex' },
        ]}
        value={value}
        onChange={setValue}
      />
    </div>
  );
}

function trigger(): HTMLButtonElement {
  const element = container.querySelector('#organisation-destination');
  if (!(element instanceof HTMLButtonElement)) throw new Error('missing destination trigger');
  return element;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

describe('OrganisationDestinationDropdown', () => {
  it('opens a custom listbox with the new-organisation choice and authorised destinations', () => {
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    act(() => trigger().click());

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.textContent).toContain('Create a new organisation');
    expect(listbox?.textContent).toContain('Acme');
    expect(listbox?.textContent).toContain('Globex');
  });

  it('selects an existing organisation and returns focus to the trigger', () => {
    act(() => trigger().click());
    const acme = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (option) => option.textContent === 'Acme',
    );
    if (!acme) throw new Error('missing Acme option');

    act(() => acme.click());

    expect(trigger().textContent).toContain('Acme');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });
});
