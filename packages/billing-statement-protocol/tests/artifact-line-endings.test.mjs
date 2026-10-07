import { describe, expect, it } from 'vitest';

import {
  normalizeArtifactLineEndings,
  serializeArtifact,
} from '../scripts/artifact-text.mjs';

describe('generated artifact text', () => {
  it('treats Windows CRLF files as the same deterministic JSON artifact', () => {
    const expected = serializeArtifact({ schemaVersion: 1, values: ['one', 'two'] });
    const windowsText = expected.replace(/\n/g, '\r\n');

    expect(normalizeArtifactLineEndings(windowsText)).toBe(expected);
    expect(normalizeArtifactLineEndings(`${expected.trim()}\n\n`)).not.toBe(expected);
  });
});
