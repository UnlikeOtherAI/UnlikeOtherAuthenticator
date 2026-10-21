import { describe, expect, it } from 'vitest';
import { applyScimPatch, parseScimAttributes, parseScimFilter, projectScimResource,
  SCIM_GROUP, SCIM_USER } from '../../src/services/enterprise-scim-protocol.service.js';

const patch = (Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });
describe('SCIM provider dialect and authority boundaries', () => {
  it('applies sequential Entra member additions/removals without dropping unrelated members', () => {
    const result = applyScimPatch({ schemas: [SCIM_GROUP], displayName: 'People', members: [{ value: 'a' }, { value: 'b' }] }, patch([
      { op: 'Add', path: 'members', value: [{ value: 'c', '$ref': null }, { value: 'a' }] },
      { op: 'Remove', path: 'members', value: [{ value: 'a' }] },
      { op: 'remove', path: 'members[value eq "b"]' },
      { op: 'add', path: 'members', value: { value: 'd' } },
    ]));
    expect(result.members).toEqual([{ value: 'c' }, { value: 'd' }]);
  });
  it('normalizes case-insensitive attributes and read-only echoes without accepting canonical identity fields', () => {
    expect(parseScimAttributes({ SCHEMAS: [SCIM_USER], USERNAME: 'Person', ACTIVE: false, id: 'foreign', meta: {},
      Name: { GIVENNAME: 'Given' }, emails: null })).toEqual({ schemas: [SCIM_USER], userName: 'Person', active: false, name: { givenName: 'Given' } });
    expect(() => parseScimAttributes({ schemas: [SCIM_USER], userId: 'canonical-person' })).toThrow();
    expect(() => parseScimAttributes({ schemas: [SCIM_USER], active: true, ACTIVE: false })).toThrow();
  });
  it('keeps false and sequential name mutations and refuses unsupported authority paths', () => {
    expect(applyScimPatch({ schemas: [SCIM_USER], userName: 'person', active: true }, patch([
      { op: 'replace', value: { active: false } }, { op: 'add', path: 'name.givenName', value: 'A' },
      { op: 'add', path: 'name.familyName', value: 'B' },
    ]))).toMatchObject({ active: false, name: { givenName: 'A', familyName: 'B' } });
    expect(() => applyScimPatch({ schemas: [SCIM_USER] }, patch([{ op: 'replace', path: 'subjectBinding', value: 'evil' }]))).toThrow();
  });
  it('bounds filter grammar and preserves mandatory attributes in subattribute projections', () => {
    expect(parseScimFilter('USERNAME eq "Person"')).toEqual({ key: 'userName', value: 'Person' });
    expect(() => parseScimFilter('userName eq "x" or active eq true')).toThrow();
    expect(projectScimResource({ id: 'stable', schemas: [SCIM_USER], meta: {}, userName: 'private',
      name: { givenName: 'A', familyName: 'B' } }, { attributes: 'name.givenName' })).toEqual({
      id: 'stable', schemas: [SCIM_USER], meta: {}, name: { givenName: 'A' },
    });
  });
});
