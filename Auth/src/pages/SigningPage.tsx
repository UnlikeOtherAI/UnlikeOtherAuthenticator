import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTranslation } from '../i18n/use-translation.js';
import {
  completeSigning,
  fetchSigningReceipt,
  fetchSigningSession,
  fetchSigningSource,
  signAgreement,
  type SigningReceipt,
  type SigningSession,
} from '../utils/signature-api.js';

function safeDownloadName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^\.+/u, '');
  return cleaned || 'document.pdf';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeDownloadName(filename);
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function isExpectedPdf(result: {
  contentType: string | null;
  etag: string | null;
}, expectedSha256: string): boolean {
  return (
    result.contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' &&
    result.etag === `"sha256-${expectedSha256}"`
  );
}

export function SigningPage(): React.JSX.Element {
  const { signingToken, redirectTo } = usePopup();
  const { language, t } = useTranslation();
  const [session, setSession] = useState<SigningSession | null>(null);
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [receiptLoadingId, setReceiptLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedMessage, setSignedMessage] = useState(false);

  const current = session?.agreements[0] ?? null;

  const loadSession = useCallback(async () => {
    if (!signingToken) {
      setError(t('signatures.restart'));
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await fetchSigningSession(signingToken);
    setLoading(false);
    if (!result.ok) {
      setSession(null);
      setError(t('signatures.restart'));
      return;
    }
    setSession(result.data);
    setError(null);
  }, [signingToken, t]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!signingToken || !current) {
      setSourceBlob(null);
      setSourceUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setSourceLoading(true);
    setSourceBlob(null);
    setSourceUrl(null);
    setAccepted(false);
    setTypedName('');
    setSignedMessage(false);
    void fetchSigningSource(signingToken, current.agreement_version_id).then((result) => {
      if (cancelled) return;
      setSourceLoading(false);
      if (!result.ok || !isExpectedPdf(result, current.source_pdf_sha256)) {
        setError(t('signatures.sourceError'));
        return;
      }
      objectUrl = URL.createObjectURL(result.data);
      setSourceBlob(result.data);
      setSourceUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current, signingToken, t]);

  async function submitSignature(): Promise<void> {
    if (!signingToken || !current || !accepted) return;
    if (current.signing_method === 'typed_name' && !typedName.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await signAgreement({
      signingToken,
      agreementVersionId: current.agreement_version_id,
      accepted,
      typedName: current.signing_method === 'typed_name' ? typedName.trim() : undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(t('signatures.signError'));
      return;
    }
    setSession(result.data.session);
    setSignedMessage(true);
    setAccepted(false);
    setTypedName('');
  }

  async function downloadReceipt(receipt: SigningReceipt): Promise<void> {
    if (!signingToken) return;
    setReceiptLoadingId(receipt.signature_id);
    setError(null);
    const result = await fetchSigningReceipt(signingToken, receipt.signature_id);
    setReceiptLoadingId(null);
    if (!result.ok || !isExpectedPdf(result, receipt.receipt_pdf_sha256)) {
      setError(t('signatures.receiptError'));
      return;
    }
    downloadBlob(
      result.data,
      `${receipt.agreement_title}-v${receipt.version}-receipt.pdf`,
    );
  }

  async function finishSignIn(): Promise<void> {
    if (!signingToken) return;
    setFinishing(true);
    setError(null);
    const result = await completeSigning(signingToken);
    setFinishing(false);
    if (!result.ok) {
      setError(t('signatures.restart'));
      return;
    }
    if (result.data.complete) {
      redirectTo(result.data.redirect_to);
      return;
    }
    await loadSession();
    setSignedMessage(false);
  }

  if (loading) {
    return <p className="text-sm text-[var(--uoa-color-muted)]">{t('signatures.loading')}</p>;
  }

  if (!session) {
    return (
      <section aria-labelledby="signature-restart-title">
        <h1 id="signature-restart-title" className="text-xl font-semibold">
          {t('auth.signatures.title')}
        </h1>
        <p className="mt-3 text-sm text-[var(--uoa-color-muted)]">{t('signatures.restart')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="signature-title" className="flex flex-col gap-5">
      <div>
        <h1 id="signature-title" className="text-2xl font-semibold">
          {t('auth.signatures.title')}
        </h1>
        <p className="mt-2 text-sm text-[var(--uoa-color-muted)]">
          {t('signatures.intro', { domain: session.domain })}
        </p>
        <p className="mt-1 text-xs text-[var(--uoa-color-muted)]">
          {t('signatures.expires', {
            time: new Date(session.expires_at).toLocaleString(language),
          })}
        </p>
      </div>

      {signedMessage ? (
        <p role="status" className="rounded-lg border border-[var(--uoa-color-border)] p-3 text-sm">
          {t('signatures.signed')}
        </p>
      ) : null}

      {current ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{current.agreement_title}</h2>
                <p className="text-sm text-[var(--uoa-color-muted)]">
                  {current.title} · {t('signatures.version', { version: String(current.version) })}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={!sourceBlob}
                onClick={() => sourceBlob && downloadBlob(sourceBlob, current.original_filename)}
              >
                {t('signatures.downloadSource')}
              </Button>
            </div>
            {current.description ? <p className="mb-3 text-sm">{current.description}</p> : null}
            {sourceLoading ? (
              <div className="flex h-[32rem] items-center justify-center rounded-lg border border-[var(--uoa-color-border)] text-sm text-[var(--uoa-color-muted)]">
                {t('signatures.loadingDocument')}
              </div>
            ) : sourceUrl ? (
              <iframe
                className="h-[32rem] w-full rounded-lg border border-[var(--uoa-color-border)] bg-white"
                src={sourceUrl}
                title={t('signatures.viewerTitle', { title: current.agreement_title })}
                referrerPolicy="no-referrer"
                sandbox=""
              />
            ) : (
              <div className="flex h-[12rem] items-center justify-center rounded-lg border border-[var(--uoa-color-border)] text-sm text-[var(--uoa-color-danger)]">
                {t('signatures.sourceError')}
              </div>
            )}
            <p className="mt-2 break-all font-mono text-xs text-[var(--uoa-color-muted)]">
              SHA-256: {current.source_pdf_sha256}
            </p>
          </div>

          <div className="flex flex-col gap-4 rounded-lg border border-[var(--uoa-color-border)] p-4">
            <div>
              <h3 className="font-semibold">{t('signatures.confirmTitle')}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm">{current.acceptance_statement}</p>
            </div>
            <label className="flex items-start gap-3 text-sm">
              <input
                className="mt-1 h-4 w-4 accent-[var(--uoa-color-primary)]"
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.currentTarget.checked)}
              />
              <span>{t('signatures.confirmCheckbox')}</span>
            </label>
            {current.signing_method === 'typed_name' ? (
              <div>
                <Input
                  label={t('signatures.fullName')}
                  value={typedName}
                  maxLength={200}
                  autoComplete="name"
                  onChange={(event) => setTypedName(event.currentTarget.value)}
                />
                <p className="mt-2 text-xs text-[var(--uoa-color-muted)]">
                  {t('signatures.nameAssertion')}
                </p>
              </div>
            ) : null}
            <p className="text-xs text-[var(--uoa-color-muted)]">{t('signatures.evidenceNotice')}</p>
            <Button
              type="button"
              disabled={
                submitting ||
                sourceLoading ||
                !sourceBlob ||
                !accepted ||
                (current.signing_method === 'typed_name' && !typedName.trim())
              }
              onClick={() => void submitSignature()}
            >
              {submitting ? t('signatures.signing') : t('signatures.signContinue')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--uoa-color-border)] p-4">
          <h2 className="text-lg font-semibold">{t('signatures.completeTitle')}</h2>
          <p className="mt-2 text-sm text-[var(--uoa-color-muted)]">
            {t('signatures.completeBody')}
          </p>
        </div>
      )}

      {session.receipts.length > 0 ? (
        <div>
          <h2 className="text-lg font-semibold">{t('signatures.receiptsTitle')}</h2>
          <div className="mt-2 flex flex-col gap-2">
            {session.receipts.map((receipt) => (
              <div
                key={receipt.signature_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--uoa-color-border)] p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {receipt.agreement_title} · {t('signatures.version', { version: String(receipt.version) })}
                  </p>
                  <p className="break-all text-xs text-[var(--uoa-color-muted)]">
                    {t('signatures.verificationReference')}: {receipt.verification_reference}
                  </p>
                  {receipt.revoked ? (
                    <p className="text-xs text-[var(--uoa-color-danger)]">{t('signatures.revoked')}</p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={receiptLoadingId === receipt.signature_id}
                  onClick={() => void downloadReceipt(receipt)}
                >
                  {receiptLoadingId === receipt.signature_id
                    ? t('signatures.downloading')
                    : t('signatures.downloadReceipt')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

      {session.complete ? (
        <Button type="button" disabled={finishing} onClick={() => void finishSignIn()}>
          {finishing ? t('signatures.finishing') : t('signatures.finish')}
        </Button>
      ) : null}
    </section>
  );
}
