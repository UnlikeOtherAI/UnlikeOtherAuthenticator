import type { Route } from '@playwright/test';

type Scope = 'USER' | 'ORGANISATION' | 'TEAM';
export function createLifecycleFixtures() {
  const templates = (['USER', 'ORGANISATION', 'TEAM'] as const).map((scope) => ({
    id: `reason-${scope}`, scope, title: 'Access review',
    message: 'Access is paused while your account is reviewed.', revision: 1, enabled: true,
  }));
  const states = new Map<string, { status: string; reason: string | null; internalNote: string | null; deletionJobId: string | null }>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  let failDelete = false;
  let blocked = false;
  let waiting = false;
  function state(path: string) {
    if (!states.has(path)) states.set(path, { status: 'ACTIVE', reason: null, internalNote: null, deletionJobId: null });
    const current = states.get(path);
    if (!current) throw new Error('Missing lifecycle fixture');
    return current;
  }
  return {
    writes, unexpected, templates,
    failNextDelete: () => { failDelete = true; },
    blockPreview: () => { blocked = true; },
    waitForProduct: () => { waiting = true; },
    async handle(route: Route, path: string) {
      const req = route.request();
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/lifecycle/templates') {
        if (req.method() === 'GET') return json({ data: templates });
        const body = req.postDataJSON(); writes.push({ path, body });
        const previous = templates.find((t) => t.id === body.id);
        if (previous) Object.assign(previous, body, { revision: previous.revision + 1 });
        else templates.push({ ...body, id: `reason-${templates.length}`, revision: 1 });
        return json(previous ?? templates.at(-1));
      }
      const jobMatch = /^\/lifecycle\/deletion-jobs\/([^/]+)(\/retry)?$/.exec(path);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json({ error: 'Unknown fixture job' }, 404);
        if (jobMatch[2]) {
          writes.push({ path, body: {} });
          if (waiting) return json({ error: 'Waiting for product' }, 409);
          job.status = 'COMPLETE';
          for (const entry of states.values()) if (entry.deletionJobId === job.id) entry.status = 'DELETED';
        }
        return json(job);
      }
      const match = /^\/lifecycle\/(USER|ORGANISATION|TEAM)\/([^/]+)(\/(deletion-preview|delete))?$/.exec(path);
      if (!match) { unexpected.push(`${req.method()} ${path}`); return json({ error: 'Unknown fixture path' }, 500); }
      const base = `/lifecycle/${match[1]}/${match[2]}`;
      const current = state(base);
      if (req.method() === 'GET') return json(current);
      const body = req.postDataJSON(); writes.push({ path, body });
      if (match[4] === 'deletion-preview') return json({
        digest: 'a'.repeat(64), confirmation: `DELETE ${match[2]}`, name: 'Fixture target', mode: body.mode,
        deletesEmptyOrganisation: match[1] === 'TEAM', teamIds: match[1] === 'USER' ? [] : ['t12'],
        candidates: [{ id: 'u101', eligible: true, reasons: [] }, { id: 'shared-user', eligible: false, reasons: ['Member of another organisation'] }],
        participants: waiting ? [{ domain: 'product.example.test' }] : [],
        retainedEvidence: [{ model: 'SignedAgreement', count: 1, reason: 'Restricted signed evidence is retained.' }],
        blockers: blocked ? ['Transfer ownership before deleting this account.'] : [],
      });
      if (match[4] === 'delete') {
        if (failDelete) { failDelete = false; return json({ error: 'Temporary failure', code: 'RETRY_REQUIRED' }, 503); }
        const job = { id: 'job-1', scope: match[1], status: waiting ? 'WAITING_FOR_PRODUCTS' : 'READY', blockers: [],
          preview: { retainedEvidence: [{ model: 'SignedAgreement', count: 1, reason: 'Restricted signed evidence is retained.' }] },
          participants: waiting ? [{ domain: 'product.example.test', acknowledgedAt: null, outcome: null }] : [] };
        jobs.set('job-1', job); current.status = 'DELETING'; current.deletionJobId = 'job-1'; return json(job);
      }
      const template = templates.find((t) => t.id === body.templateId && t.scope === match[1] as Scope);
      if (body.status === 'DISABLED' && !template) return json({ error: 'Invalid scope' }, 400);
      Object.assign(current, { status: body.status, reason: template?.message ?? null, internalNote: body.internalNote ?? null });
      return json(current);
    },
  };
}
