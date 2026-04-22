import type { EndpointSchema } from './schema.js';

export const integrationsEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/integrations/claim/:token',
    description:
      'One-time claim confirmation page for an approved integration request. Intentionally does NOT consume the token — link scanners cannot accidentally burn it.',
    auth: 'public, no auth; token in path is a 32-byte random value hashed at rest',
    response: {
      200: 'HTML confirm page with a POST form targeting /integrations/claim/:token/confirm',
      404: 'HTML invalid-link page when the token is missing, expired, used, or malformed',
    },
  },
  {
    method: 'POST',
    path: '/integrations/claim/:token/confirm',
    description:
      'Consumes the claim token and renders the one-time reveal page containing the partner client_secret and client_hash. Subsequent requests return the invalid-link page.',
    auth: 'public; the token in the path IS the credential',
    response: {
      200: 'HTML reveal page: { domain, client_secret, client_hash, hash_prefix } shown once. Partner copies both into their backend secret store before closing.',
      404: 'HTML invalid-link page when the token is missing, expired, used, or malformed',
    },
  },
];
