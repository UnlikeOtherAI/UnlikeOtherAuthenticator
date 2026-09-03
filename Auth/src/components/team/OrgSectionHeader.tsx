import React from 'react';

/** The `<h2>` label for one organisation's team group below the chooser `<h1>`. */
export function OrgSectionHeader(props: { orgName: string }): React.JSX.Element {
  return (
    <h2 className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-[var(--uoa-color-muted)]">
      {props.orgName}
    </h2>
  );
}
