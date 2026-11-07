/** Extend only a financial DTO. Existing team/content schemas are never relaxed. */
export function organisationFinancialSubjectSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(organisationFinancialSubjectSchema) as T;
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key,value]) =>
    [key,organisationFinancialSubjectSchema(value)])) as Record<string,unknown>;
  const properties = result.properties as Record<string,unknown> | undefined;
  if (properties?.team_id) properties.team_id = { anyOf: [properties.team_id,{type:'null'}] };
  // Statement actions carry dynamic string bodies. Admit null only for the
  // named team subject, never return URLs, IDs, tokens or arbitrary properties.
  if (result.type === 'object' && (result.additionalProperties as {type?:unknown} | undefined)?.type === 'string') {
    result.properties = { ...properties,team_id:{anyOf:[{type:'string',minLength:1,maxLength:256},{type:'null'}]} };
  }
  return result as T;
}
