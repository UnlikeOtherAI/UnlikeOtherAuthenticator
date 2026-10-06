import { Icon } from './icons/Icon';

export function DebugLoginButton({ onClick }: { onClick: () => void }) {
  return <button type="button" aria-label="Debug login" title="Debug login" onClick={onClick}
    className="fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-lg hover:bg-gray-50 hover:text-gray-900">
    <Icon name="bug" className="h-5 w-5" />
  </button>;
}
