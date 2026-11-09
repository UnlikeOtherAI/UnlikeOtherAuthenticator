# Native social sign-in

Kelpie previously received Google and password only: native app validation, the
Admin form and hosted social controls each restricted the provider list, and
the native callback/completion services assumed Google. Website provider
credentials alone could not enable another native method.

Native app policies now accept Google, Apple, Facebook, GitHub, LinkedIn and X,
plus email/password. Operators select methods in Admin → Native apps → Kelpie →
Edit app. Configure provider credentials and the existing service callback before
selecting a provider. This is operator state; deployment does not change app policy.

Both website and native initiation use the existing provider adapters and one
authorization URL builder. Their state, account completion and grant boundaries
remain separate. Native flows store the provider and X verifier with their
authorization context. Old Google flows can finish during their existing
15-minute lifetime.

Each native callback checks the stored provider, browser cookie, current app
revision, exact redirect and scopes. Callback and completion are one-use.
X uses S256 PKCE with its server-held verifier. Apple posts cross-site and needs
SameSite=None on its Secure, HttpOnly initial per-flow cookie; the hosted
continuation switches to SameSite=Strict. Cancellation returns the original state.

Google, Apple, GitHub, LinkedIn and X must supply verified email. Facebook first
requires its existing browser-bound mailbox proof before linking a new provider
subject; subsequent sign-ins may use that exact verified subject and address.
A native proof resumes its original native database flow. It cannot mint or
complete a confidential website grant. Failed/expired proofs require retry or
a new sign-in; no account is created before proof succeeds.

Registration policy, credential epoch, bans, TOTP/enrollment and required
signatures are checked through the existing services. Evidence and continuation
retain the actual provider. App security edits invalidate old clients and
sessions, so users must sign in again after methods change.

No Kelpie binary change or native build is required. Publish UOA, enable the
configured methods in its live app record, then start a fresh Kelpie sign-in.
Provider destination checks verify availability; complete third-party account
sign-ins only with the account owner's authorization.
