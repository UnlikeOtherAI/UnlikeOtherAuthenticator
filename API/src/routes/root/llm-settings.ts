export const llmSettingsMarkdown = `
---

## User settings

Optional per-user namespaced JSON storage (e.g. \`browser\` → \`bookmarks\`, or \`global\` → \`theme\`) shared across every product the user signs into, through the dual-auth \`/settings/me\` endpoints — integration guide: [Docs/Auth/user-settings.md](https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator/blob/main/Docs/Auth/user-settings.md).
Native public clients can use PKCE at /oauth/authorize and /oauth/token, without a product backend or shared secret. Request profile, settings.read and settings.write scopes at registration and authorization. GET /oauth/me returns the current profile; GET /oauth/me/avatar resolves its avatar. GET /oauth/me/settings/:namespace/:key returns {value} and an ETag (null for an absent key). PUT the same path with {value} and If-Match. Retry 409 by rereading and reapplying the intended change, never by blindly overwriting. The subject comes exclusively from the token. Tokens expire without refresh; repeat hosted sign-in. See Docs/Auth/native-accounts.md.
`;
