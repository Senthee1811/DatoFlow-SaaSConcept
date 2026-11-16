import { cn } from './cn';

/** The wordmark in display type, with a flat mark: a dated next step, drawn as a filled square with a notch. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg aria-hidden viewBox="0 0 20 20" className="size-5 fill-ember">
        <path d="M2 2h16v11l-5 5H2z" />
        <path d="M13 18v-5h5z" className="fill-obsidian" />
      </svg>
      <span className="display text-subheading leading-none">DatoFlow</span>
    </span>
  );
}
