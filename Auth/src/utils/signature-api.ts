import { postBinary, postJson, type ApiBinaryResult, type ApiResult } from './api.js';

export type SigningAgreement = {
  agreement_id: string;
  agreement_version_id: string;
  agreement_title: string;
  title: string;
  description: string | null;
  version: number;
  original_filename: string;
  signing_method: 'clickwrap' | 'typed_name';
  acceptance_statement: string;
  source_pdf_sha256: string;
};

export type SigningReceipt = {
  signature_id: string;
  agreement_title: string;
  version: number;
  verification_reference: string;
  receipt_pdf_sha256: string;
  signed_at: string;
  revoked: boolean;
};

export type SigningSession = {
  domain: string;
  expires_at: string;
  initial_policy_revision: number;
  policy_revision: number;
  complete: boolean;
  agreements: SigningAgreement[];
  receipts: SigningReceipt[];
};

type SessionResponse = { ok: true } & SigningSession;

export function fetchSigningSession(signingToken: string): Promise<ApiResult<SessionResponse>> {
  return postJson('/signatures/session', { signing_token: signingToken });
}

export function fetchSigningSource(
  signingToken: string,
  agreementVersionId: string,
): Promise<ApiBinaryResult> {
  return postBinary('/signatures/session/source', {
    signing_token: signingToken,
    agreement_version_id: agreementVersionId,
  });
}

type SignResponse = {
  ok: true;
  signature_id: string;
  verification_reference: string;
  receipt_pdf_sha256: string;
  session: SessionResponse;
};

export function signAgreement(params: {
  signingToken: string;
  agreementVersionId: string;
  accepted: boolean;
  typedName?: string;
}): Promise<ApiResult<SignResponse>> {
  return postJson('/signatures/session/sign', {
    signing_token: params.signingToken,
    agreement_version_id: params.agreementVersionId,
    accepted: params.accepted,
    typed_name: params.typedName ?? null,
  });
}

export function fetchSigningReceipt(
  signingToken: string,
  signatureId: string,
): Promise<ApiBinaryResult> {
  return postBinary('/signatures/session/receipt', {
    signing_token: signingToken,
    signature_id: signatureId,
  });
}

type CompleteResponse = {
  ok: true;
  complete: boolean;
  signatures_required?: boolean;
  redirect_to: string;
};

export function completeSigning(signingToken: string): Promise<ApiResult<CompleteResponse>> {
  return postJson('/signatures/session/complete', { signing_token: signingToken });
}
