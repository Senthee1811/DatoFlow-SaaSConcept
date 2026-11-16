import { ChevronDown } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';

const control =
  'w-full bg-chalk text-obsidian border-[1.5px] border-obsidian font-body text-body ' +
  'placeholder:text-obsidian/65 transition-colors duration-150 ' +
  'aria-[invalid=true]:bg-sulfur disabled:opacity-50';

/** Inputs are pills with a 1.5px Obsidian border. */
export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(control, 'min-h-12 rounded-inputs px-5', className)}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ref,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(control, 'min-h-12 appearance-none rounded-inputs pr-12 pl-5', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 right-5 size-4 -translate-y-1/2"
      />
    </div>
  );
}

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea ref={ref} className={cn(control, 'rounded-medium px-5 py-3', className)} {...props} />
  );
}

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  /** One control. It receives the id and the aria attributes that tie it to the label and messages. */
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
}

/** A labelled form control with an optional hint and an error message. */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label htmlFor={id} className="px-5 text-body-sm">
        {label}
      </label>
      {control}
      {hint && !error ? (
        <p id={hintId} className="caption px-5 text-obsidian/70">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="px-5 text-body-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
