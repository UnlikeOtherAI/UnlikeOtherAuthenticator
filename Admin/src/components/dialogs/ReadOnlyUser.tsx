export function ReadOnlyUser({ email, name }: { email: string; name: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <p className="text-sm font-medium text-gray-900">{name}</p>
      <p className="text-xs text-gray-500">{email}</p>
    </div>
  );
}
