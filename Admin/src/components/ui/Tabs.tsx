import { cn } from '../../utils/cn';

type TabOption<T extends string> = {
  label: string;
  value: T;
};

type SegmentedTabsProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: Array<TabOption<T>>;
};

export function SegmentedTabs<T extends string>({ onChange, options, value }: SegmentedTabsProps<T>) {
  return (
    <div className="mb-4 flex w-fit gap-px rounded-lg bg-gray-200 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          className={cn(
            'h-8 rounded-md px-3 text-sm font-medium transition-colors',
            value === option.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900',
          )}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
