/** Extend only a financial DTO. Existing team/content schemas are never relaxed. */
export function organisationFinancialSubjectSchema<T>(schema: T): T {
  const visit=(value:unknown,key?:string):unknown=>{
    if(Array.isArray(value))return value.map(item=>visit(item,key));
    if(!value||typeof value!=='object')return value;
    const result=Object.fromEntries(Object.entries(value).map(([child,node])=>[child,visit(node,child)]));
    const properties=result.properties as Record<string,unknown>|undefined;
    if(properties?.team_id&&properties.organisation_id&&properties.user_id) {
      properties.team_id={anyOf:[properties.team_id,{type:'null'}]};
    }
    // Statement action bodies are string records. Only their named actor team
    // gains null. Captured team scopes, return URLs and other records do not.
    if(key==='body'&&result.type==='object'&&(result.additionalProperties as {type?:unknown}|undefined)?.type==='string') {
      result.properties={...properties,team_id:{anyOf:[{type:'string',minLength:1,maxLength:256},{type:'null'}]}};
    }
    return result;
  };
  return visit(schema) as T;
}
