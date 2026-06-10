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

type UnderlineTabOption<T extends string> = TabOption<T> & {
  count?: number;
};

type UnderlineTabsProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: Array<UnderlineTabOption<T>>;
};

/**
 * Page-level tab bar with an underline indicator. Suited to detail pages that expose several
 * sibling sections (more than a segmented pill group should hold). Optional per-tab counts render
 * as a pill beside the label.
 */
export function UnderlineTabs<T extends string>({ onChange, options, value }: UnderlineTabsProps<T>) {
  return (
    <div className="mb-5 border-b border-gray-200">
      <nav className="-mb-px flex flex-wrap items-center gap-x-6 gap-y-1" aria-label="Tabs">
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-2 border-b-2 px-0.5 pb-2.5 pt-1 text-sm font-medium transition-colors',
                active
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-900',
              )}
              onClick={() => onChange(option.value)}
            >
              {option.label}
              {option.count !== undefined ? (
                <span
                  className={cn(
                    'inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
                    active ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-500',
                  )}
                >
                  {option.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
