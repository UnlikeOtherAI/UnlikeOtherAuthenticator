export const llmWebsiteServicesMarkdown = `
## Independent website services in subfolders

The hostname-only instructions above remain valid for existing integrations.
A separate service at https://therockbottom.co.uk/rafikimedia/ instead signs
\`domain: "therockbottom.co.uk/rafikimedia"\`. The hostname plus canonical,
lowercase mount path (no trailing slash) is its complete service identity.

Publish its config and JWKS beneath that exact path. UOA verifies both hostname
and path-segment boundaries; /rafikimedia-other/ and the parent / are not this
service. JWKS redirects must stay inside the same service path. Paths permit
lowercase letters, digits, underscores and hyphens in nonempty segments only.
Do not use URL schemes, query strings, ports, percent escapes or dot segments
in the identity. Config/JWKS use HTTPS on the default port.

Register/approve this identity as its own entry in Admin > Services, with its
own signing key, secret, login allowlist, redirect allowlist and label. Derive
the backend bearer as SHA256(full service identity + its own client secret).
Send that full identity as every domain query/claim. URL-encode it when used
in an admin route parameter. Existing admin tools store the full identity;
they must never select the hostname record as a fallback.

Global UOA identities remain shared; access, domain roles, organisation origin
scope and credentials are separate. Granting Rock Bottom access does not grant
Rafiki access. Use separate UOA family membership/policy for Rafiki. This is an
additive registration: existing hostname rows are not renamed or migrated, and
no users, roles, memberships or signing keys are copied from the parent.

A shared browser origin is still a browser trust boundary: a subfolder is not
isolation against malicious JavaScript served elsewhere on that same origin.
Use separate origins if that threat must also be isolated. Machine-readable
configuration and endpoint contracts are at [/api](/api).
`;
