import React from 'react';

export function QrCodeDisplay(props: {
  src?: string;
  alt?: string;
}): React.JSX.Element {
  const alt = props.alt ?? '2FA setup QR code';

  if (!props.src) {
    return (
      <div
        aria-label={alt}
        className={[
          'flex aspect-square w-full items-center justify-center',
          'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
          'bg-[var(--uoa-color-surface)] text-sm text-[var(--uoa-color-muted)]',
        ].join(' ')}
      >
        QR code will appear here
      </div>
    );
  }

  return (
    <div
      className={[
        'flex w-full items-center justify-center p-3',
        'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
        'bg-[var(--uoa-color-surface)]',
      ].join(' ')}
    >
      <img
        src={props.src}
        alt={alt}
        className="h-auto w-full max-w-[260px] select-none"
        draggable={false}
      />
    </div>
  );
}

