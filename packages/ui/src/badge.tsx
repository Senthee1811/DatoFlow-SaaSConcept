import { CalendarClock, Check, CircleAlert, type LucideIcon } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type Tone = 'sulfur' | 'ember' | 'limestone';

const tones: Record<Tone, string> = {
  sulfur: 'bg-sulfur',
  ember: 'bg-ember',
  limestone: 'bg-limestone',
};

/** Tags and badges: a pill with Obsidian text, DM Sans 500 at 12 to 14px. */
export function Badge({
  tone = 'sulfur',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pills px-3 py-1 text-body-sm whitespace-nowrap text-obsidian',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

const STATUS: Record<'attention' | 'today' | 'done', { tone: Tone; icon: LucideIcon }> = {
  attention: { tone: 'ember', icon: CircleAlert },
  today: { tone: 'sulfur', icon: CalendarClock },
  done: { tone: 'limestone', icon: Check },
};

/**
 * Status never relies on colour alone: each badge carries an icon and a word.
 * Stuck or overdue = Ember, due today = Sulfur, done or neutral = Limestone.
 */
export function StatusBadge({
  status,
  children,
}: {
  status: keyof typeof STATUS;
  children: string;
}) {
  const { tone, icon: Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {children}
    </Badge>
  );
}
