import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { body, display } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'DatoFlow', template: '%s · DatoFlow' },
  description:
    'Every open lead has an owner, a dated next step and a deadline. DatoFlow shows you the ones that slipped.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        {children}
        <Toaster
          position="bottom-center"
          toastOptions={{
            unstyled: true,
            classNames: {
              toast:
                'flex w-full items-center gap-3 rounded-medium bg-obsidian px-5 py-4 text-body-sm text-chalk sm:w-96',
            },
          }}
        />
      </body>
    </html>
  );
}
