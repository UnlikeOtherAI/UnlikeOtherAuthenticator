/**
 * Labels no organisation or team may claim.
 *
 * A slug is a DNS label under a product's tenant base domain, so this list is
 * not about tidiness: a team that took `api` would shadow the product's own
 * API host for every person on that organisation's subdomain, and one that
 * took `mail` or `mx` would sit where mail infrastructure is looked up.
 *
 * Products extend this through `hostnames.reserved_labels` in their signed
 * config rather than by editing this file — a product knows its own hostnames
 * and this package does not. `reservedLabelsFor` computes the union.
 */
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  // The eight the organisation path already refused, kept exactly.
  'admin',
  'api',
  'internal',
  'me',
  'system',
  'settings',
  'new',
  'default',

  // Product and identity surfaces.
  'app',
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'sso',
  'oauth',
  'id',
  'account',
  'accounts',

  // Conventional web hosts.
  'www',
  'www2',
  'static',
  'cdn',
  'assets',
  'media',
  'img',
  'images',
  'files',
  'download',
  'downloads',

  // Mail and DNS, where a wrong answer breaks delivery rather than a page.
  'mail',
  'smtp',
  'imap',
  'pop',
  'email',
  'mx',
  'ns',
  'ns1',
  'ns2',
  'dns',
  'ftp',
  'autodiscover',
  'autoconfig',

  // Operations.
  'help',
  'support',
  'status',
  'docs',
  'dev',
  'staging',
  'test',
  'demo',
  'sandbox',
  'localhost',
  'metrics',
  'health',

  // Words that read as a bug when they appear in a hostname.
  'root',
  'null',
  'undefined',
  'none',

  // The vocabulary of the hierarchy itself.
  'team',
  'teams',
  'org',
  'orgs',
  'organisation',
  'organization',
  'organisations',
  'organizations',
  'project',
  'projects',

  // Estate services.
  'push',
  'vault',
  'ledger',
]);

/**
 * The reserved set for one product: this package's base list plus whatever the
 * product declared in its signed config.
 *
 * Extension is additive only. A product cannot un-reserve a base label — the
 * base list exists because those labels break something for everyone, and a
 * product that could drop `mx` from it would be buying a subdomain at the cost
 * of its own mail.
 */
export function reservedLabelsFor(extra?: Iterable<string>): ReadonlySet<string> {
  if (!extra) return RESERVED_LABELS;

  const union = new Set(RESERVED_LABELS);
  for (const label of extra) {
    const normalized = label.trim().toLowerCase();
    if (normalized) union.add(normalized);
  }
  return union;
}

/**
 * Structural reservations that no list can enumerate.
 *
 * `xn--` is the IDNA A-label prefix: a slug carrying it claims to be an encoded
 * internationalised name and resolvers will try to decode it. A leading
 * underscore is the shape of an underscore-prefixed service record. Both are
 * refused by rule rather than by listing every instance.
 */
export function isStructurallyReserved(slug: string): boolean {
  return slug.startsWith('_') || slug.startsWith('xn--');
}
