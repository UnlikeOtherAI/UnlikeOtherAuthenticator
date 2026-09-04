export const llmAutomaticMembershipMarkdown = `
### Automatic team membership (Nessie)

Nessie may call the narrow \`/org/automatic-membership/*\` contract only with a
dedicated \`automatic_membership\` app key bound to the \`nessie\` service. UOA
rejects every organisation without current direct Nessie service-access evidence.
The contract returns stable subjects, never emails; UOA validates current verified
identity data itself and grants only \`member\` roles, preserving stronger roles.
The product's ordinary domain bearer, user profile cache, and billing app keys are
not valid credentials for this capability. See \`GET /api\` for each endpoint.
`;
