// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegistrationCodeInput } from './RegistrationCodeInput.js';

let host: HTMLDivElement, root: Root;
const complete = vi.fn();
function Harness() {
  const [value, setValue] = useState('');
  return <RegistrationCodeInput value={value} onChange={setValue} onComplete={complete} label="Verification code" />;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  complete.mockReset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const inputs = () => [...host.querySelectorAll('input')];
function type(index: number, value: string) {
  const input = inputs()[index];
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function paste(index: number, value: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => value } });
  act(() => inputs()[index].dispatchEvent(event));
}
function key(index: number, value: string) {
  act(() => inputs()[index].dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
}

describe('six-character registration entry', () => {
  it('has six accessible fields and uppercases typing while advancing focus', () => {
    expect(inputs()).toHaveLength(6);
    inputs()[0].focus(); type(0, 'a');
    expect(inputs()[0].value).toBe('A'); expect(document.activeElement).toBe(inputs()[1]);
    expect(inputs()[0].autocomplete).toBe('one-time-code');
    expect(complete).not.toHaveBeenCalled();
  });
  it('distributes a full pasted code from any field and completes once', () => {
    paste(3, 'ab3k7m');
    expect(inputs().map(input => input.value)).toEqual(['A', 'B', '3', 'K', '7', 'M']);
    expect(complete).toHaveBeenCalledExactlyOnceWith('AB3K7M');
  });
  it('accepts multi-character autofill and removes forbidden characters', () => {
    type(0, 'a b3-k7m!');
    expect(complete).toHaveBeenCalledExactlyOnceWith('AB3K7M');
  });
  it('clears an interior field without moving its later characters', () => {
    paste(0, 'AB3K7M'); complete.mockReset();
    key(2, 'Backspace');
    expect(inputs().map(input => input.value)).toEqual(['A', 'B', '', 'K', '7', 'M']);
    expect(document.activeElement).toBe(inputs()[2]); expect(complete).not.toHaveBeenCalled();
    type(2, '4'); expect(complete).toHaveBeenCalledExactlyOnceWith('AB4K7M');
  });
  it('backspaces from an empty field and supports left/right/home/end', () => {
    type(0, 'A'); key(1, 'Backspace');
    expect(inputs()[0].value).toBe(''); expect(document.activeElement).toBe(inputs()[0]);
    key(0, 'End'); expect(document.activeElement).toBe(inputs()[5]);
    key(5, 'ArrowLeft'); expect(document.activeElement).toBe(inputs()[4]);
    key(4, 'Home'); expect(document.activeElement).toBe(inputs()[0]);
    key(0, 'ArrowRight'); expect(document.activeElement).toBe(inputs()[1]);
  });
  it('submits once when the last typed character completes the code', () => {
    for (const [index, character] of [...'AB3K7M'].entries()) type(index, character);
    expect(complete).toHaveBeenCalledExactlyOnceWith('AB3K7M');
  });
});
