type RootPageAssets = {
  iconHref: string;
  stylesheetHref: string;
};

const links = [
  {
    href: '/admin',
    label: 'Admin',
    description: 'Operator dashboard for domains, users, teams, feature flags, and connection errors.',
    variant: 'primary',
  },
  {
    href: '/llm',
    label: '/llm',
    description: 'LLM-facing integration guide for config JWTs, auth flows, and admin access.',
    variant: 'secondary',
  },
  {
    href: '/api',
    label: '/api',
    description: 'Machine-readable endpoint schema, config contract, and service metadata.',
    variant: 'secondary',
  },
] as const;

function linkClass(variant: 'primary' | 'secondary'): string {
  const base =
    'inline-flex h-9 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900';
  if (variant === 'primary') {
    return `${base} border-indigo-600 bg-indigo-600 text-white hover:border-indigo-500 hover:bg-indigo-500 focus:ring-indigo-500`;
  }
  return `${base} border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700 focus:ring-indigo-500`;
}

function renderLogo(iconHref: string): string {
  if (!iconHref) {
    return '<span class="flex h-32 w-32 items-center justify-center rounded-[20px] border border-slate-800 bg-slate-900 text-2xl font-semibold tracking-tight text-white">UOA</span>';
  }
  return `<img src="${iconHref}" width="140" height="140" class="h-32 w-32 rounded-[20px]" alt="UOA" />`;
}

export function renderRootHoldingPage(assets: RootPageAssets): string {
  const stylesheet = assets.stylesheetHref
    ? `<link rel="stylesheet" crossorigin href="${assets.stylesheetHref}">`
    : '';
  const renderedLinks = links
    .map(
      (link) => `
          <li class="rounded-2xl border border-slate-800 bg-slate-900 px-6 py-5 shadow-2xl">
            <a class="${linkClass(link.variant)}" href="${link.href}">${link.label}</a>
            <p class="mt-3 text-center text-sm text-slate-400">${link.description}</p>
          </li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en" class="h-full">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Unlike Other Authenticator</title>
    ${stylesheet}
  </head>
  <body class="h-full bg-slate-950">
    <main class="flex min-h-full flex-col justify-center bg-slate-950 px-6 py-12">
      <div class="mx-auto w-full max-w-md">
        <div class="flex flex-col items-center gap-3">
          ${renderLogo(assets.iconHref)}
          <h1 class="text-2xl font-semibold tracking-tight text-white">Unlike Other Authenticator</h1>
        </div>
        <p class="mt-2 text-center text-sm text-slate-400">Central OAuth and authentication service.</p>
        <ul class="mt-8 space-y-5">${renderedLinks}
        </ul>
      </div>
    </main>
  </body>
</html>`;
}
