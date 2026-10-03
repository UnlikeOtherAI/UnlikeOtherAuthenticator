import { useLocation, useNavigate } from 'react-router';

export function useDirectoryNavigation(fallback: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const recordState = { directoryFrom: location.pathname + location.search };
  const previous: unknown = location.state?.directoryFrom;
  const backPath = typeof previous === 'string' && /^\/(users|organisations|teams)([/?]|$)/.test(previous) ? previous : fallback;
  return {
    recordState,
    openRecord: (path: string) => navigate(path, { state: recordState }),
    goBack: () => navigate(backPath),
  };
}
