import React from 'react';

import { useTranslation } from '../../i18n/use-translation.js';

/**
 * The organisation heading above a group of workspaces, with the "add a workspace here" control.
 *
 * An org is the level above a workspace, so its create control stays close to the group rather
 * than becoming another full-width card in the list. When a card (or its creation form) is
 * present, the control overlaps that first item's top-right corner: it is visibly tied to the
 * workspace group without reading as part of the first workspace itself.
 *
 * It is an `<h2>` because the chooser title is the `<h1>`: with that many groups, heading
 * navigation is how a screen-reader user moves through this screen. The button carries the org in
 * its accessible name, since a bare "+" cannot say whether it adds an organisation or a workspace.
 */
export function OrgSectionHeader(props: {
  orgName: string;
  formId: string;
  onToggleCreate?: () => void;
  expanded?: boolean;
  disabled?: boolean;
  overlapCreateControl?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const addLabel = t('workspace.orgSection.addWorkspace', { org: props.orgName });

  return (
    <div className="flex min-h-4 items-center gap-2">
      <h2
        className={[
          'min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-[var(--uoa-color-muted)]',
          props.overlapCreateControl ? 'pr-10' : '',
        ].join(' ')}
      >
        {props.orgName}
      </h2>
      {props.onToggleCreate ? (
        <button
          type="button"
          onClick={props.onToggleCreate}
          disabled={props.disabled}
          aria-label={addLabel}
          title={addLabel}
          aria-expanded={props.expanded ?? false}
          aria-controls={props.formId}
          // The visual circle straddles the first card's top edge: 9px (one third) inside and
          // 19px above it. The larger 44px button preserves the touch target and centers the
          // circle on the card's right edge.
          className={[
            props.overlapCreateControl
              ? 'absolute -right-[22px] top-px z-10 flex h-11 w-11 items-center justify-center'
              : '-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center',
            'text-[var(--uoa-color-primary)] disabled:cursor-not-allowed disabled:opacity-60',
          ].join(' ')}
        >
          <span
            aria-hidden="true"
            className={[
              'flex h-7 w-7 items-center justify-center rounded-full text-lg leading-none',
              'border border-[var(--uoa-color-border)] transition-colors',
              'hover:border-[var(--uoa-color-primary)]',
            ].join(' ')}
          >
            {props.expanded ? '×' : '+'}
          </span>
        </button>
      ) : null}
    </div>
  );
}
