import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'quiet-danger';
type Size = 'md' | 'sm';

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-body text-body font-medium ' +
  'transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50 ' +
  'active:scale-[0.98] transition-[background-color,border-color,color,transform]';

const variants: Record<Variant, string> = {
  // Ember fill, Obsidian text, full pill.
  primary: 'bg-ember text-obsidian rounded-pills px-6 hover:bg-obsidian hover:text-chalk',
  // Transparent, 1.5px Obsidian border, 40px radius.
  secondary:
    'bg-transparent text-obsidian rounded-buttons border-[1.5px] border-obsidian px-4 hover:bg-obsidian hover:text-chalk',
  // No border, pill radius, 0 12px padding.
  ghost: 'bg-transparent text-obsidian rounded-pills px-3 hover:bg-pumice',
  'quiet-danger':
    'bg-transparent text-obsidian rounded-pills px-3 underline decoration-dotted underline-offset-4 hover:bg-sulfur',
};

// Touch targets are at least 44px. `sm` is for dense rows and still meets 44px.
const sizes: Record<Size, string> = {
  md: 'min-h-12',
  sm: 'min-h-11 text-body-sm',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({
  variant,
  size,
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin" strokeWidth={1.75} />
      ) : null}
      {children}
    </button>
  );
}
