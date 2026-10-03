import { useLocation, useNavigate } from 'react-router';

function isDirectoryPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(users|organisations|teams|domains|logs|connection-errors|superusers|billing|apps|integrations|feature-flags|bans|delegations|api-keys|dashboard)([/?]|$)/.test(value);
}

/** Carry bounded return context through related records, including their filters and tabs. */
export function useDirectoryNavigation(fallback: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const previous: unknown = location.state?.directoryFrom;
  const rawTrail: unknown = location.state?.directoryTrail;
  const trail = Array.isArray(rawTrail)
    ? rawTrail.filter(isDirectoryPath).slice(-20)
    : isDirectoryPath(previous) ? [previous] : [];
  const current = location.pathname + location.search;
  const recordState = { directoryFrom: current, directoryTrail: [...trail, current].slice(-20) };
  const backPath = trail.at(-1) ?? fallback;
  return {
    recordState,
    openRecord: (path: string) => navigate(path, { state: recordState }),
    goBack: () => navigate(backPath, { state: { directoryTrail: trail.slice(0, -1), directoryFrom: trail.at(-2) } }),
  };
}
