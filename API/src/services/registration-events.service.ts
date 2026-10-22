// Only non-secret state-change hints travel here. Database reads decide authority.
const listeners = new Map<string, Set<() => void>>();

export function publishRegistrationChange(id: string): void {
  listeners.get(id)?.forEach(listener => listener());
}

export function subscribeRegistrationChanges(id: string, listener: () => void): () => void {
  const group = listeners.get(id) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(id, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(id);
  };
}
