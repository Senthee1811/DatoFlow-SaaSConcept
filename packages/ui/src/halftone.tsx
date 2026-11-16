import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** The halftone dot block. Decorative, so hidden from assistive technology. */
export function Halftone({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('halftone', className)} {...props} />;
}
