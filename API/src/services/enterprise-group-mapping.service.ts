import { z } from 'zod';

/** An external group identifier is meaningful only inside its exact provider connection. */
export const GroupMapping = z.object({ connection_id: z.string().min(1).max(100),
  external_group_id: z.string().min(1).max(256), team_id: z.string().min(1).max(100),
  team_role: z.enum(['member', 'admin']) }).strict();
export function connectionGroupMappings(raw: unknown, connectionId: string) {
  return GroupMapping.array().max(100).parse(raw).filter(mapping => mapping.connection_id === connectionId);
}

/** Owners can repair old invalid policy without the response claiming it is executable. */
export function groupMappingView(raw: unknown, connectionIds: string[], teamIds: string[]) {
  if (!Array.isArray(raw)) return { group_mappings: [], invalid_group_mappings: 1 };
  const connections = new Set(connectionIds); const teams = new Set(teamIds);
  const valid = raw.slice(0, 100).flatMap(value => {
    const parsed = GroupMapping.safeParse(value);
    return parsed.success && connections.has(parsed.data.connection_id) && teams.has(parsed.data.team_id) ? [parsed.data] : [];
  });
  return { group_mappings: valid, invalid_group_mappings: raw.length - valid.length };
}
