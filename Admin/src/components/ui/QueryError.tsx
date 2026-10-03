import { Button } from './Button';

export function QueryError({ retry, message = 'Could not load this information.' }: { retry: () => unknown; message?: string }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{message}</p><Button className="mt-3" onClick={() => void retry()}>Try again</Button></div>;
}
