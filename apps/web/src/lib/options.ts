import { DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from '@datoflow/shared';

export const TIMEZONES: string[] = [
  'UTC',
  ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC'),
];

/** Common agency currencies first, then the rest in order. */
const FIRST = ['LKR', 'USD', 'EUR', 'GBP', 'INR', 'AUD', 'SGD', 'AED'];
export const CURRENCIES: string[] = [
  ...FIRST,
  ...Intl.supportedValuesOf('currency').filter((c) => !FIRST.includes(c)),
];

export { DEFAULT_CURRENCY, DEFAULT_TIMEZONE };

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
