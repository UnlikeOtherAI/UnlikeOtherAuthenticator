import React, { useEffect, useId, useRef, useState } from 'react';
import { checkSlug, deriveSlugBase } from '@unlikeotherai/slug';

import { fieldInputClassName } from '../ui/Input.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { checkSlugAvailability, type AuthFlowQuery } from '../../utils/api.js';

/**
 * The address field: the moment somebody chooses the subdomain their team will
 * live at.
 *
 * Three decisions worth stating, because they are what make this field usable
 * rather than merely present:
 *
 * 1. **It follows the name until it is touched.** Most people never think about
 *    the address, and for them typing a name should be the whole interaction.
 *    The moment somebody edits the address it stops following, because from
 *    then on it is theirs — silently overwriting it on the next keystroke of
 *    the name would be the same disrespect as coercing it server-side.
 * 2. **It validates locally and asks the server only when the shape is legal.**
 *    The rules come from `@unlikeotherai/slug`, the same module the server
 *    validates with, so "that will not work" never disagrees between the two.
 *    A malformed label is answered instantly and costs no request.
 * 3. **It says what is wrong, not that something is.** Every rejection maps to
 *    its own sentence, because "invalid" gives somebody nothing to act on.
 */

const DEBOUNCE_MS = 300;

/**
 * Every rejection gets its own sentence. Spelled out rather than built from a
 * template so the translation keys stay statically checked — a reason with no
 * copy is then a build error, not a blank line under the field.
 */
const REASON_KEYS = {
  taken: 'team.address.error.taken',
  too_short: 'team.address.error.too_short',
  too_long: 'team.address.error.too_long',
  charset: 'team.address.error.charset',
  double_hyphen: 'team.address.error.double_hyphen',
  all_digits: 'team.address.error.all_digits',
  reserved: 'team.address.error.reserved',
} as const;

type Reason = keyof typeof REASON_KEYS;

type Scope = { kind: 'organisation' } | { kind: 'team'; orgId: string };

type Status =
  | { state: 'empty' }
  | { state: 'invalid'; reason: Reason }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: Reason };

export function TeamAddressField(props: {
  /** The name field's current value; the address follows it until touched. */
  name: string;
  value: string;
  onChange: (value: string) => void;
  onStatusChange?: (usable: boolean) => void;
  scope: Scope;
  loginToken: string;
  query: AuthFlowQuery;
  /** e.g. `nessie.works`. Absent renders the label alone. */
  baseDomain?: string;
  /** The organisation label this team will sit under, when known. */
  parentSlug?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const inputId = useId();
  const statusId = useId();
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<Status>({ state: 'empty' });
  const requestSeq = useRef(0);

  const fallback = props.scope.kind === 'team' ? 'team' : 'org';
  const derived = props.name.trim() ? deriveSlugBase(props.name, { fallback }) : '';
  const effective = touched ? props.value : derived;

  // Keep the parent's value in step while the field is still following the
  // name, so submitting without ever touching the address still sends one.
  useEffect(() => {
    if (!touched && derived !== props.value) props.onChange(derived);
    // props.onChange is stable in practice; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, touched]);

  useEffect(() => {
    if (!effective) {
      setStatus({ state: 'empty' });
      return;
    }

    const local = checkSlug(effective);
    if (!local.ok) {
      setStatus({ state: 'invalid', reason: local.reason });
      return;
    }

    setStatus({ state: 'checking' });
    const seq = ++requestSeq.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await checkSlugAvailability(
          {
            login_token: props.loginToken,
            slug: local.slug,
            ...(props.scope.kind === 'team' ? { org_id: props.scope.orgId } : {}),
          },
          props.query,
        );
        // A slower earlier answer must never overwrite a newer one.
        if (seq !== requestSeq.current) return;

        if (!result.ok) {
          // An unreachable check must not block creation: the server validates
          // again on submit, and that is the answer that counts.
          setStatus({ state: 'available' });
          return;
        }
        setStatus(
          result.data.available
            ? { state: 'available' }
            : { state: 'unavailable', reason: result.data.reason ?? 'taken' },
        );
      })();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective, props.scope.kind, props.scope.kind === 'team' ? props.scope.orgId : '']);

  useEffect(() => {
    props.onStatusChange?.(status.state === 'available' || status.state === 'empty');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);

  const message = ((): { text: string; tone: 'muted' | 'error' | 'ok' } | null => {
    switch (status.state) {
      case 'empty':
        return null;
      case 'checking':
        return { text: t('team.address.checking'), tone: 'muted' };
      case 'available':
        return { text: t('team.address.available'), tone: 'ok' };
      case 'invalid':
      case 'unavailable':
        return { text: t(REASON_KEYS[status.reason]), tone: 'error' };
    }
  })();

  const suffix = props.baseDomain
    ? `.${props.parentSlug ? `${props.parentSlug}.` : ''}${props.baseDomain}`
    : '';

  return (
    <div>
      <label
        htmlFor={inputId}
        className="mb-1 block text-sm font-medium text-[var(--uoa-color-text)]"
      >
        {t('team.address.label')}
      </label>

      <div className="flex items-center gap-1">
        <input
          id={inputId}
          className={fieldInputClassName()}
          value={effective}
          onChange={(event) => {
            setTouched(true);
            props.onChange(event.target.value.trim().toLowerCase());
          }}
          disabled={props.disabled}
          maxLength={63}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={statusId}
          aria-invalid={status.state === 'invalid' || status.state === 'unavailable'}
        />
        {suffix ? (
          <span className="shrink-0 text-sm text-[var(--uoa-color-muted)]">{suffix}</span>
        ) : null}
      </div>

      <p
        id={statusId}
        aria-live="polite"
        className={[
          'mt-1 text-xs',
          message?.tone === 'error'
            ? 'text-[var(--uoa-color-danger)]'
            : 'text-[var(--uoa-color-muted)]',
        ].join(' ')}
      >
        {message ? message.text : t('team.address.hint')}
      </p>
    </div>
  );
}
