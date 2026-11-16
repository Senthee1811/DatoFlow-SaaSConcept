import { Anton, DM_Sans } from 'next/font/google';

// PP Neue Corp Compact is commercial. Until licensed .woff2 files are added to public/fonts,
// display type uses Anton. To switch, load them here with next/font/local under the same variable.
export const display = Anton({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display-face',
});

// Body type is DM Sans at weight 500 only.
export const body = DM_Sans({
  weight: '500',
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-body-face',
});
