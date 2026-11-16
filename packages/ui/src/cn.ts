import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the Caldera type scale, so `text-body` and `text-obsidian` do not collide.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'caption',
            'body-sm',
            'body',
            'subheading',
            'heading-sm',
            'heading',
            'heading-lg',
            'heading-2xl',
            'heading-3xl',
            'display',
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
