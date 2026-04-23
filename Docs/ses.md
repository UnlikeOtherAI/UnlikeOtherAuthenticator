# AWS SES Email Setup

## Account & Region

- **AWS Account:** 946926531695
- **Production SES Region:** `eu-west-1` (Ireland) — 50,000 emails/day, out of sandbox
- **Backup SES Region:** `us-east-1` — sandbox only (200/day), all domains also registered here
- **IAM User:** `uoa-auth-ses` — send-only permissions (`ses:SendEmail`, `ses:SendRawEmail`)

## Domains

All domains are verified in both `eu-west-1` (production) and `us-east-1`:

| Domain | Cloudflare Zone ID | Status |
|---|---|---|
| unlikeotherai.com | `6c7593165ded0ef08d5cd4ca52279407` | Verified |
| ideasbox.live | `bbc392f8bda1c9ae60780db50377e243` | Verified |
| teleprompter.rocks | `85d024f8864c4f933ea9eba8f1247425` | Verified |
| myplace.rocks | `252173e2b806d92537fc451ecb1d5398` | Verified |
| adgoes.live | `8a792e3bb1d4b20028707a7c3c2079b3` | Verified |

**Not on Cloudflare:** einstore.pro, painpoint.center (not purchased)

## DNS Records (per domain)

Each domain has these records on Cloudflare:

1. **SES Domain Verification** — `TXT _amazonses.<domain>` (one per SES region)
2. **DKIM** — 3x `CNAME <token>._domainkey.<domain>` → `<token>.dkim.amazonses.com` (one set per region, so 6 CNAMEs total)
3. **SPF** — `TXT <domain>` → `v=spf1 include:amazonses.com ~all`
4. **DMARC** — `TXT _dmarc.<domain>` → `v=DMARC1; p=quarantine; rua=mailto:info@<domain>`
5. **MAIL FROM (bounce subdomain):**
   - `MX bounce.<domain>` → `feedback-smtp.us-east-1.amazonses.com` (priority 10)
   - `TXT bounce.<domain>` → `v=spf1 include:amazonses.com ~all`

## Cloud Run Configuration

**Service:** `uoa-auth` | **Region:** `europe-west1` | **Project:** `gen-lang-client-0561071620`

Environment variables:

```
EMAIL_PROVIDER=ses
AWS_REGION=eu-west-1
EMAIL_FROM=noreply@unlikeotherai.com
EMAIL_REPLY_TO=hello@unlikeotherai.com
```

Secrets (GCP Secret Manager):

```
AWS_ACCESS_KEY_ID    → uoa-auth-aws-access-key-id:latest
AWS_SECRET_ACCESS_KEY → uoa-auth-aws-secret-access-key:latest
```

Service account `uoa-auth@gen-lang-client-0561071620.iam.gserviceaccount.com` has `secretmanager.secretAccessor` on both secrets.

## How to Add a New Domain

1. Register in SES: `aws ses verify-domain-identity --domain <domain> --region eu-west-1`
2. Get DKIM tokens: `aws ses verify-domain-dkim --domain <domain> --region eu-west-1`
3. Enable DKIM: `aws ses set-identity-dkim-enabled --identity <domain> --dkim-enabled --region eu-west-1`
4. Set MAIL FROM: `aws ses set-identity-mail-from-domain --identity <domain> --mail-from-domain bounce.<domain> --behavior-on-mx-failure UseDefaultValue --region eu-west-1`
5. Add DNS records on Cloudflare (see "DNS Records" section above)
6. Verify: `aws ses get-identity-verification-attributes --identities <domain> --region eu-west-1`

## Email Forwarding

Cloudflare Email Routing is enabled on all 5 domains. Each has a rule forwarding `info@<domain>` to `ondrej.rafaj@gmail.com`.

Managed via the Global API Key (`CLOUDFLARE_FULL_TOKEN` in `.zshrc`) with `X-Auth-Key` + `X-Auth-Email: ondrej.rafaj@gmail.com` headers. The DNS-only token (`CLOUDFLARE_API_TOKEN`) cannot manage email routing.

## Useful Commands

```bash
# Check domain verification
aws ses get-identity-verification-attributes --identities <domain> --region eu-west-1

# Check DKIM status
aws ses get-identity-dkim-attributes --identities <domain> --region eu-west-1

# Check send quota (confirms production vs sandbox)
aws ses get-send-quota --region eu-west-1

# List all identities
aws ses list-identities --region eu-west-1

# Send test email
aws ses send-email --from noreply@unlikeotherai.com --to <recipient> \
  --subject "Test" --text "Test email" --region eu-west-1
```

## Admin Sender Registration IAM

Per-domain sender registration from the UOA Admin panel uses optional dedicated SES admin credentials:

```
AWS_SES_ADMIN_ACCESS_KEY_ID
AWS_SES_ADMIN_SECRET_ACCESS_KEY
AWS_SES_ADMIN_REGION=eu-west-1
```

The admin key needs identity-management permissions in the SES region used for sender registration:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:VerifyDomainIdentity",
        "ses:VerifyDomainDkim",
        "ses:SetIdentityDkimEnabled",
        "ses:SetIdentityMailFromDomain",
        "ses:GetIdentityVerificationAttributes",
        "ses:GetIdentityDkimAttributes"
      ],
      "Resource": "*"
    }
  ]
}
```

The existing `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` remain the send credentials for `ses:SendEmail`.
