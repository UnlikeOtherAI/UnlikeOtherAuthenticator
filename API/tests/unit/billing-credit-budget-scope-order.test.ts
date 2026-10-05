import { describe, expect, it } from 'vitest';

import { budgetScopes } from '../../src/services/billing-credit-budget-dispatch.service.js';

describe('credit budget lock order', () => {
  it('orders exact ancestor keys by UTF-8 bytes across product namespaces', () => {
    const scopes = budgetScopes({ product: 'a', orgId: 'org', teamId: 'team',
      context: { contextId: 'context', originProduct: 'Z',
        originSourceDomain: 'z.example.com', projectId: 'project',
        runId: 'run-b', budgetRunId: 'run-A' },
    });
    expect(scopes.map((scope) => `${scope.product}/${scope.scopeType}/${scope.scopeId}`))
      .toEqual([
        'Z/organization/org', 'Z/project/project', 'Z/run/run-A',
        'Z/run/run-b', 'Z/team/team', 'a/organization/org', 'a/team/team',
      ]);
  });
});
