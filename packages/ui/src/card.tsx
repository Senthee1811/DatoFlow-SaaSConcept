import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type Tone = 'limestone' | 'ember' | 'obsidian';
type Density = 'page' | 'dense';

const tones: Record<Tone, string> = {
  limestone: 'bg-limestone text-obsidian',
  // On Ember, text under 24px stays Obsidian (white on Ember is only about 3.3:1).
  ember: 'bg-ember text-obsidian',
  obsidian: 'bg-obsidian text-chalk',
};

// Page-level cards keep 40px radius and padding; dense surfaces use 20px radius.
const densities: Record<Density, string> = {
  page: 'rounded-cards p-6 sm:p-10',
  dense: 'rounded-medium p-4 sm:p-6',
};

export function Card({
  tone = 'limestone',
  density = 'page',
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { tone?: Tone; density?: Density }) {
  return <section className={cn(tones[tone], densities[density], className)} {...props} />;
}
