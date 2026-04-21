type PublicExplanation = {
  summary: string;
  details?: string[];
  hints?: string[];
};

function titleCase(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join(' ');
}

function providerNameFromCode(code: string): string {
  return titleCase(code.split('_')[0] ?? code);
}

export function explainAuthProviderCode(code: string): PublicExplanation | null {
  switch (code) {
    case 'SOCIAL_PROVIDER_DISABLED':
      return {
        summary: 'The requested social provider is not enabled for this client config.',
        hints: ['Add the provider to enabled_auth_methods in the signed config.'],
      };
    case 'SOCIAL_PROVIDER_MISMATCH':
      return {
        summary:
          'The social callback provider does not match the provider stored in the signed state.',
        hints: ['Restart the social login flow instead of reusing a stale callback URL.'],
      };
    case 'SOCIAL_PROVIDER_ERROR':
      return {
        summary: 'The OAuth provider returned an error during the social login callback.',
        hints: [
          'Check the provider error query parameters and the provider-side app configuration.',
        ],
      };
    case 'MISSING_SOCIAL_CALLBACK_PARAMS':
      return {
        summary: 'The social callback request is missing required parameters.',
        hints: ['Check that the provider redirected back with both code and state.'],
      };
    case 'INVALID_SOCIAL_STATE':
      return {
        summary:
          'The social login state token is invalid, expired, or does not match this auth service.',
        hints: ['Restart the social login flow to obtain a fresh state token.'],
      };
    case 'SOCIAL_STATE_SIGN_FAILED':
      return {
        summary: 'The server failed to sign the social login state token.',
        hints: ['Check SHARED_SECRET and the auth-service environment configuration.'],
      };
    case 'SOCIAL_EMAIL_NOT_VERIFIED':
      return {
        summary:
          'The social provider did not return a verified email address, so the login was rejected.',
        hints: ['Use an account with a provider-verified email address.'],
      };
    case 'AI_TRANSLATION_DISABLED':
      return {
        summary:
          'AI translation fallback was requested, but no AI translation provider is enabled.',
        hints: [
          'Enable a supported AI translation provider or pre-populate the required translations.',
        ],
      };
    case 'OPENAI_API_KEY_MISSING':
      return {
        summary: 'OpenAI-backed translation fallback is enabled, but OPENAI_API_KEY is missing.',
        hints: ['Set OPENAI_API_KEY and redeploy the service.'],
      };
    case 'AI_TRANSLATION_FAILED':
      return {
        summary: 'The AI translation provider request failed.',
        hints: [
          'Check the provider credentials, model configuration, and outbound network access.',
        ],
      };
  }

  if (/_ENV_MISSING$/.test(code)) {
    const provider = providerNameFromCode(code);
    return {
      summary: `${provider} OAuth is enabled for this flow, but the server is missing required environment configuration.`,
      hints: [`Set the required ${provider} OAuth client credentials and redeploy the service.`],
    };
  }

  if (/_TOKEN_EXCHANGE_FAILED$/.test(code)) {
    const provider = providerNameFromCode(code);
    return {
      summary: `The server could not exchange the authorization code with ${provider}.`,
      hints: [
        `Check the ${provider} OAuth client credentials, callback URL, and provider-side app configuration.`,
      ],
    };
  }

  if (/_USERINFO_FAILED$/.test(code)) {
    const provider = providerNameFromCode(code);
    return {
      summary: `The server could not load the authenticated profile from ${provider}.`,
      hints: [`Check the ${provider} access token scope and provider availability.`],
    };
  }

  if (/_EMAIL_MISSING$/.test(code)) {
    const provider = providerNameFromCode(code);
    return {
      summary: `${provider} did not return an email address, so the login was rejected.`,
      hints: [
        'Use an account that exposes an email address to the provider or choose another login method.',
      ],
    };
  }

  if (/_EMAIL_NOT_VERIFIED$/.test(code)) {
    const provider = providerNameFromCode(code);
    return {
      summary: `${provider} returned an email address that is not verified.`,
      hints: ['Use an account with a provider-verified email address.'],
    };
  }

  if (/^INVALID_TOTP_/.test(code) || code === 'INVALID_OTPAUTH_URI') {
    return {
      summary: 'The 2FA/TOTP value supplied to the server is invalid.',
      hints: [
        'Check the TOTP secret, code length, issuer, account name, and time-window settings.',
      ],
    };
  }

  if (/^TOTP_SECRET_/.test(code) || code === 'INVALID_ENCRYPTED_TOTP_SECRET') {
    return {
      summary: 'The server could not safely encrypt or decrypt the stored TOTP secret.',
      hints: ['Check the encryption key material and stored 2FA secret format.'],
    };
  }

  if (/^TWOFA_/.test(code)) {
    return {
      summary: 'The server could not complete the requested 2FA operation.',
      hints: ['Check the current user state, 2FA configuration, and server-side secret handling.'],
    };
  }

  if (code === 'DEFAULT_TEAM_MISSING' || /_SLUG_COLLISION_RETRY_EXHAUSTED$/.test(code)) {
    return {
      summary:
        'The server could not complete the organisation/team operation because required internal records could not be created or resolved.',
      hints: ['Check the organisation/team data integrity and retry the operation.'],
    };
  }

  if (code === 'MISSING_USER' || code === 'TOKEN_SIGN_FAILED' || code === 'AUTH_CODE_COLLISION') {
    return {
      summary: 'The server could not complete token issuance for this request.',
      hints: ['Check the related user record, token signing configuration, and retry the flow.'],
    };
  }

  return null;
}
