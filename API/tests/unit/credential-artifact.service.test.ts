import { describe, expect, it } from 'vitest';
import { credentialArtifactSource, assertCredentialArtifactProof } from '../../src/services/credential-artifact.service.js';

const proof = { id: 'original', provenance: 'sso', method: 'sso', connectionId: 'connection', amr: ['email_password'] };
describe('signed credential provenance markers', () => {
  it('rejects missing, ambiguous, malformed and wrong-class signed sources even at legacy floors', () => {
    for (const payload of [{ assurance_version: 1 }, { auth_method: 'sso' }, { assurance_id: null },
      { assurance_version: 2, assurance_id: 'id' }, { assurance_id: 'id', authentication_evidence_id: 'id' },
      { assurance_ref: 'reference' }, { authentication_evidence_id: 'evidence' }]) {
      expect(() => credentialArtifactSource(payload, 'session')).toThrow('INVALID_CREDENTIAL_ARTIFACT');
    }
    expect(() => credentialArtifactSource({ assurance_id: 'original' }, 'reference')).toThrow();
    expect(() => credentialArtifactSource({ auth_method: 'sso', assurance_method: 'independent', assurance_id: 'id' }, 'session')).toThrow();
  });
  it('never treats upstream password AMR as independent account proof', () => {
    expect(() => assertCredentialArtifactProof({ assuranceId: 'original', method: 'email_password' }, proof)).toThrow();
    expect(() => assertCredentialArtifactProof({ assuranceId: 'original', method: 'sso', connectionId: 'foreign' }, proof)).toThrow();
    expect(() => assertCredentialArtifactProof({ assuranceId: 'foreign' }, proof)).toThrow();
    expect(() => assertCredentialArtifactProof({ assuranceId: 'original', method: 'sso', connectionId: 'connection' }, proof)).not.toThrow();
    expect(() => assertCredentialArtifactProof({ method: 'recovery' }, { ...proof, provenance: 'independent' })).toThrow();
  });
  it('requires the referenced proof and binds accompanying signed metadata exactly', () => {
    const artifact = credentialArtifactSource({ assurance_ref: 'opaque', assurance_id: 'original', assurance_version: 1,
      assurance_connection_id: 'connection', assurance_method: 'sso' }, 'reference');
    expect(() => assertCredentialArtifactProof(artifact, null)).toThrow();
    expect(() => assertCredentialArtifactProof(artifact, proof)).not.toThrow();
  });
});
