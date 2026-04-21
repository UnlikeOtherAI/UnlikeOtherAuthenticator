type AvatarProps = {
  label: string;
  shape?: 'round' | 'square';
  size?: 'sm' | 'md';
};

export function Avatar({ label, shape = 'round', size = 'sm' }: AvatarProps) {
  const sizeClass = size === 'md' ? 'h-12 w-12 text-lg' : 'h-8 w-8 text-xs';
  const shapeClass = shape === 'square' ? 'rounded-xl' : 'rounded-full';

  return <span className={`flex shrink-0 items-center justify-center ${sizeClass} ${shapeClass} bg-indigo-100 font-semibold text-indigo-700`}>{initials(label)}</span>;
}

function initials(value: string) {
  return value
    .split(' ')
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
