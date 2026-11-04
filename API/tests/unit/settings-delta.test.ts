import { describe, expect, it } from 'vitest';
import { settingsDelta } from '../../src/services/settings-delta.js';
import { SettingsStreamQueue } from '../../src/services/settings-stream-queue.js';

describe('settings stream operations', () => {
  it('reconstructs inserted, deleted, reordered and edited arrays without dropping opaque fields', () => {
    const before = Array.from({ length: 100 }, (_, id) => ({ id, title: `Item ${id}`, foreign: { retained: true } }));
    const afters = [before.slice(1), [...before, { id: 100, title: 'new', foreign: { retained: true } }],
      [before[1], before[0], ...before.slice(2)], before.map((v, i) => i === 50 ? { ...v, title: 'renamed' } : v), []];
    for (const after of afters) {
      const operation = settingsDelta(before, after);
      const result = [...before] as unknown[];
      if (operation.type === 'splice') result.splice(operation.index, operation.deleteCount, ...operation.items);
      expect(operation.type === 'replace' ? operation.value : result).toEqual(after);
      expect(JSON.stringify(operation).length).toBeLessThanOrEqual(JSON.stringify({ type: 'replace', value: after }).length);
    }
    expect(settingsDelta(before, afters[3]).type).toBe('splice');
  });
  it('replaces scalars, objects and deleted values', () => {
    for (const value of [null, true, 'text', { nested: { changed: true } }]) {
      expect(settingsDelta({ old: true }, value)).toEqual({ type: 'replace', value });
    }
  });
  it('serializes reads and continues after a rejected job', async () => {
    const queue = new SettingsStreamQueue();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const order: number[] = [];
    const first = queue.run(async () => { order.push(1); await gate; throw new Error('revoked'); });
    const failed = expect(first).rejects.toThrow('revoked');
    const second = queue.run(async () => { order.push(2); return 3; });
    await Promise.resolve();
    expect(order).toEqual([1]);
    finish();
    await failed;
    expect(await second).toBe(3);
    expect(order).toEqual([1, 2]);
  });
});
