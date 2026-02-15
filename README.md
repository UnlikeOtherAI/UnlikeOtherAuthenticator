# Unlike Other Authenticator

A **centralized OAuth & authentication service** designed to provide unified login across multiple products with configurable branding, UI, and security features.

## What It Does

Unlike Other Authenticator is a stateless, API-first authentication service that enables:

- **Unified authentication** across 4–5+ products with a single account per email
- **Multiple auth methods**: Email/password, Google, Apple, Facebook, GitHub, LinkedIn
- **Configurable branding**: Per-client UI theming, logos, colors, and language support
- **Optional 2FA**: TOTP-based two-factor authentication
- **Secure configuration**: Tamper-proof JWT-based config delivery
- **Zero admin UI**: Client onboarding through signed configuration only

## How It Works

### Trust Model

1. **Client Identification**: Each client is identified by a verified domain. The hash of `(domain + shared secret)` becomes the client ID.
2. **Config Delivery**: All client configuration is delivered as a signed JWT. The OAuth server verifies the JWT signature before trusting any config.
3. **OAuth Flow**: Uses the standard authorization code flow. Client popup redirects with a code, which the client backend exchanges for an access token.
4. **Stateless Tokens**: Access tokens are short-lived JWTs (15–60 minutes) with no refresh tokens. Clients re-initiate OAuth when tokens expire.

### Core Principles

- Email is the canonical user identifier
- No email enumeration protection across all flows
- All client config is signed and verified
- Everything UI-related is templated and config-driven
- No avatars stored locally (external URLs only)
- Generic error messages only (no information leakage)

## Configuration Options

Configuration is delivered as a **signed JWT** with the following properties:

### Required Fields

- `domain` — Client domain (e.g., `app.example.com`)
- `redirect_urls` — Array of allowed OAuth redirect URLs
- `enabled_auth_methods` — Array of enabled methods: `["email", "google", "apple", "facebook", "github", "linkedin"]`
- `ui_theme` — Complete theme object (colors, radii, typography, logo URL, density)
- `language_config` — Single language string or array of language codes

### Optional Fields

- `2fa_enabled` — Boolean to enable/disable 2FA (default: `false`)
- `debug_enabled` — Boolean to enable debug endpoints (default: `false`)
- `allowed_social_providers` — Array of social provider names to enable
- `user_scope` — `"global"` (default) or `"per_domain"` (isolate users per domain)
- `language` — Selected language (must be in `language_config` if provided)
- `org_features` — Organisation/team/group feature configuration (see below)

### Organisation Features (Optional)

Enable organisations, teams, and groups by adding `org_features` to the config:

```json
{
  "org_features": {
    "enabled": true,
    "groups_enabled": false,
    "max_teams_per_org": 100,
    "max_members_per_org": 1000,
    "max_team_memberships_per_user": 50,
    "org_roles": ["owner", "admin", "member"]
  }
}
```

When enabled, the access token JWT includes an `org` claim with the user's organisation, team, and group memberships. Groups are managed exclusively through the Internal API (`/internal/org/`) using signed requests. See [Section 24 of the brief](./Docs/brief.md#24-organisations-teams--groups) for the full specification.

### JWT Signing

All config JWTs must be signed with the shared secret using HS256. Expected claims:

- `aud` — Auth service identifier (set in `AUTH_SERVICE_IDENTIFIER` env var)
- `exp` — Optional expiration (configs are verified on every request)

## Installation

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL 14+
- Social provider OAuth credentials (Google, Apple, Facebook, GitHub, LinkedIn)
- SMTP server (optional, for email functionality)

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/unlike-other-authenticator.git
cd unlike-other-authenticator
```

### 2. Install Dependencies

```bash
npm install
```

This installs dependencies for both the API and Auth workspaces.

### 3. Environment Variables

Create `.env` files in both `/API` and `/Auth` directories.

#### API Environment Variables (`/API/.env`)

```bash
# Required
SHARED_SECRET=your-secret-key-here
AUTH_SERVICE_IDENTIFIER=auth.yourservice.com
DATABASE_URL=postgresql://user:password@localhost:5432/auth_db

# Social OAuth Providers
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
# ... (Apple, Facebook, GitHub, LinkedIn credentials)

# Email Service (optional)
EMAIL_PROVIDER=smtp  # or 'disabled'
EMAIL_FROM=noreply@yourservice.com
EMAIL_REPLY_TO=support@yourservice.com
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASSWORD=your-smtp-password

# Optional Configuration
ACCESS_TOKEN_TTL=30  # minutes (15-60)
LOG_RETENTION_DAYS=90
```

### 4. Database Setup

```bash
# Generate Prisma client
npm run prisma:generate --workspace API

# Run database migrations
npm run prisma:migrate:dev --workspace API
```

### 5. Run Development Servers

```bash
# Terminal 1: Run API server
npm run dev:api

# Terminal 2: Run Auth UI
npm run dev:auth
```

The API runs on `http://localhost:3000` by default.
The Auth UI runs on `http://localhost:5173` by default.

### 6. Build for Production

```bash
npm run build
```

This builds both API and Auth workspaces.

### 7. Run in Production

```bash
# Apply production migrations
npm run prisma:migrate:deploy --workspace API

# Start API server
npm run start --workspace API
```

## Architecture

### Project Structure

```
/API              — Node.js OAuth/auth server (Fastify)
/Auth             — React auth UI (Vite + Tailwind)
/Docs             — Full specification and architecture docs
  brief.md        — Complete product specification
  techstack.md    — Technology stack and structure
  architecture-api.md    — API layered architecture
  architecture-auth.md   — Auth UI component architecture
CLAUDE.md         — Agent/contributor instructions
```

### API Architecture

The API follows a **layered architecture**:

```
Request → Routes → Middleware → Services → Database (Prisma)
```

- **Routes** (`/src/routes`): Thin handlers that validate input and call services
- **Middleware** (`/src/middleware`): Config verification, domain auth, error handling
- **Services** (`/src/services`): Business logic for auth, users, tokens, social providers, email
- **Utils** (`/src/utils`): Pure helper functions (hashing, validation, errors)

**Key Rules:**
- No code file longer than 500 lines
- Thin routes, fat services
- All errors are generic to users, detailed in internal logs
- Prisma for all database access

### Auth UI Architecture

The Auth UI is a **React application** with config-driven theming:

```
PopupContainer
  └── ThemeProvider (config-driven)
      └── I18nProvider (language-driven)
          └── AuthLayout
              └── [Page Components]
```

- **Components** (`/src/components`): Reusable UI primitives (buttons, cards, inputs) and auth forms
- **Pages** (`/src/pages`): Auth flow screens (login, register, 2FA setup, etc.)
- **Theme** (`/src/theme`): Maps config theme to Tailwind classes
- **i18n** (`/src/i18n`): Translation loading with AI fallback for missing keys

**Key Rules:**
- Tailwind-only styling (no other CSS frameworks)
- All theming from config (no hardcoded brand styles)
- One component per file for reusable components
- No component file longer than 500 lines

### Database Schema

**Core Tables:**
- `users` — User accounts (email, password hash, name, avatar URL, 2FA settings)
- `domain_roles` — Per-domain role assignments (superuser vs user)
- `login_logs` — Audit trail of authentication events
- `verification_tokens` — One-time tokens for email verification and password reset

**Organisation Tables** (opt-in via `org_features` config):
- `organisations` — Tenant organisations, scoped per domain
- `org_members` — User-to-org membership with configurable roles
- `teams` — Named groups of users within an organisation
- `team_members` — User-to-team membership with lead/member roles
- `groups` — Named collections of teams (enterprise feature)
- `group_members` — User-to-group membership with admin flag

**User Scope:**
- **Global** (default): One email = one user across all domains
- **Per-domain**: Same email on different domains = separate user records

### Security Model

- **No email enumeration**: All responses are generic ("Check your email")
- **Shared secret**: Single global secret (never exposed, env var only)
- **Config integrity**: All configs signed with JWT, verified on every request
- **Domain verification**: Runs on each auth initiation (not cached)
- **Social email trust**: Only provider-verified emails accepted
- **Short-lived tokens**: Access tokens expire in 15–60 minutes (no refresh tokens)
- **Generic errors**: All user-facing error messages are non-specific

## Development

### Available Scripts

```bash
# Development
npm run dev:api          # Start API server in watch mode
npm run dev:auth         # Start Auth UI dev server

# Building
npm run build            # Build both workspaces

# Code Quality
npm run lint             # Lint all workspaces
npm run format           # Format code with Prettier
npm run typecheck        # TypeScript type checking

# Testing
npm run test             # Run tests in all workspaces

# Database
npm run prisma:generate --workspace API       # Generate Prisma client
npm run prisma:migrate:dev --workspace API    # Create and apply migration
npm run prisma:studio --workspace API         # Open Prisma Studio
```

### Testing

```bash
# Run all tests
npm test

# Run API tests only
npm test --workspace API

# Watch mode (during development)
npm test -- --watch --workspace API
```

Tests are written using Vitest and cover:
- Unit tests for all services
- Integration tests for API endpoints
- Security tests (enumeration protection, generic errors, token validation)

## Client Integration

### 1. Generate Signed Config

On your client backend:

```javascript
import jwt from 'jsonwebtoken';

const config = {
  domain: 'app.example.com',
  redirect_urls: ['https://app.example.com/auth/callback'],
  enabled_auth_methods: ['email', 'google'],
  ui_theme: {
    colors: { primary: '#3b82f6', secondary: '#64748b' },
    borderRadius: '0.5rem',
    // ... full theme config
  },
  language_config: ['en', 'es'],
  2fa_enabled: true,
  user_scope: 'global'
};

const configJWT = jwt.sign(config, process.env.SHARED_SECRET, {
  audience: 'auth.yourservice.com',
  algorithm: 'HS256'
});

// Serve this JWT at a URL accessible to the auth server
```

### 2. Initiate OAuth Flow

On your client frontend:

```javascript
const configUrl = 'https://app.example.com/api/auth-config'; // serves the JWT
const authUrl = `https://auth.yourservice.com/oauth/authorize?config_url=${encodeURIComponent(configUrl)}`;

window.open(authUrl, 'oauth', 'width=500,height=700');
```

### 3. Handle OAuth Callback

On your client backend:

```javascript
// Callback route receives the authorization code
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  // Exchange code for access token
  const response = await fetch('https://auth.yourservice.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: hashDomainAndSecret(domain, sharedSecret)
    })
  });

  const { access_token } = await response.json();

  // Verify and decode the JWT access token
  const user = jwt.verify(access_token, process.env.SHARED_SECRET);

  // Set session and redirect
  req.session.userId = user.id;
  res.redirect('/dashboard');
});
```

## API Endpoints

### Authentication

- `POST /auth/login` — Email/password login
- `POST /auth/register` — Email registration (sends verification email)
- `POST /auth/verify-email` — Verify email with token
- `POST /auth/reset-password` — Request password reset
- `GET /auth/callback/:provider` — Social OAuth callback
- `POST /auth/token` — Exchange authorization code for access token

### Two-Factor Authentication

- `POST /2fa/setup` — Initiate 2FA enrollment (returns QR code)
- `POST /2fa/verify` — Verify TOTP code during setup or login
- `POST /2fa/reset` — Email-based 2FA reset

### Domain-Scoped APIs

- `GET /domain/users` — List users for domain (requires domain hash token)
- `GET /domain/logs` — Get login logs for domain
- `GET /domain/debug` — Debug endpoints (superuser only)

### Organisations, Teams & Groups (opt-in)

These endpoints require `org_features.enabled: true` in the config JWT.

**User-Facing** (require domain hash token + user access token):
- `POST /org/organisations` — Create an organisation (auto-creates default team)
- `GET /org/organisations/:orgId` — Get organisation details
- `PUT /org/organisations/:orgId` — Update organisation
- `DELETE /org/organisations/:orgId` — Delete organisation (owner only)
- `GET /org/organisations/:orgId/members` — List members
- `POST /org/organisations/:orgId/members` — Add member (by userId)
- `POST /org/organisations/:orgId/transfer-ownership` — Transfer ownership
- `GET /org/organisations/:orgId/teams` — List teams
- `POST /org/organisations/:orgId/teams` — Create team
- `GET /org/organisations/:orgId/groups` — List groups (read-only)
- `GET /org/me` — Current user's org context

**Internal API** (require domain hash token only, no user token):
- `POST /internal/org/organisations/:orgId/groups` — Create group
- `PUT /internal/org/organisations/:orgId/groups/:groupId` — Update group
- `DELETE /internal/org/organisations/:orgId/groups/:groupId` — Delete group
- `POST /internal/org/organisations/:orgId/groups/:groupId/members` — Add group member
- `PUT /internal/org/organisations/:orgId/groups/:groupId/members/:userId` — Toggle is_admin
- `DELETE /internal/org/organisations/:orgId/groups/:groupId/members/:userId` — Remove group member
- `PUT /internal/org/organisations/:orgId/teams/:teamId/group` — Assign/unassign team to group

See [Section 24 of the brief](./Docs/brief.md#24-organisations-teams--groups) for the full specification.

### Health

- `GET /health` — Health check endpoint

## Contributing

See [`CLAUDE.md`](./CLAUDE.md) for contributor guidelines and [`Docs/brief.md`](./Docs/brief.md) for the complete specification.

**Key Rules:**
- Read the brief before making changes
- Never remove content from `Docs/brief.md` unless explicitly instructed
- Follow architecture patterns in `Docs/architecture-api.md` and `Docs/architecture-auth.md`
- No code file longer than 500 lines
- Keep the codebase reusable and clean
- Security first: no enumeration, no information leakage, all config verified

## License

MIT — See [LICENSE](./LICENSE) file for details.

## Support

For issues and questions:
- GitHub Issues: [https://github.com/yourusername/unlike-other-authenticator/issues](https://github.com/yourusername/unlike-other-authenticator/issues)

---

**Built with:** Node.js, TypeScript, Fastify, React, Tailwind CSS, PostgreSQL, Prisma
