import { useEffect, useState } from 'react';

import { AllowedEmailDomainsField } from './AllowedEmailDomainsField';
import { AllowedEmailsField } from './AllowedEmailsField';
import { Button } from '../ui/Button';
import { FieldShell } from '../ui/FormFields';

export type LoginRestrictionValue = {
  allowedEmailDomains: string[];
  allowedEmails: string[];
};

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Card that edits and saves an allowed-login-email-domains list for one scope (organisation or
 * team). Login is blocked for users whose email domain is not in the list (SUPERUSER bypasses).
 */
export function LoginRestrictionSection({
  title,
  description,
  allowedEmailDomains,
  allowedEmails,
  onSave,
}: {
  title: string;
  description: string;
  allowedEmailDomains: string[];
  allowedEmails: string[];
  onSave: (next: LoginRestrictionValue) => Promise<unknown>;
}) {
  const [domainDraft, setDomainDraft] = useState<string[]>(allowedEmailDomains);
  const [emailDraft, setEmailDraft] = useState<string[]>(allowedEmails);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setDomainDraft(allowedEmailDomains);
  }, [allowedEmailDomains]);

  useEffect(() => {
    setEmailDraft(allowedEmails);
  }, [allowedEmails]);

  const dirty =
    !sameList(domainDraft, allowedEmailDomains) || !sameList(emailDraft, allowedEmails);

  async function save() {
    setSaving(true);
    setError(false);
    try {
      await onSave({ allowedEmailDomains: domainDraft, allowedEmails: emailDraft });
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="mt-0.5 text-xs text-gray-500">{description}</p>
        </div>
        <Button
          icon="check"
          variant="primary"
          size="sm"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label="Allowed email domains">
          <AllowedEmailDomainsField value={domainDraft} onChange={setDomainDraft} />
        </FieldShell>
        <FieldShell label="Allowed individual emails">
          <AllowedEmailsField value={emailDraft} onChange={setEmailDraft} />
        </FieldShell>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-red-600">Could not save. Check the domains and emails and try again.</p>
      ) : null}
    </section>
  );
}
