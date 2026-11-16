import { Halftone, Logo } from '@datoflow/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Auth screens: the form on calm Pumice, the halftone block as artwork beside it. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid min-h-dvh max-w-page grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6 lg:p-6">
      <main className="flex flex-col">
        <header className="py-4 pl-2">
          <Link href="/" className="inline-flex rounded-pills" aria-label="DatoFlow home">
            <Logo />
          </Link>
        </header>
        <div className="flex flex-1 items-center py-8 lg:py-16">
          <div className="w-full max-w-lg">{children}</div>
        </div>
      </main>
      <aside className="hidden lg:flex lg:flex-col lg:justify-end">
        <Halftone className="flex min-h-full flex-col justify-end p-10">
          <p className="display relative z-10 max-w-md text-heading-lg text-chalk">
            Every open lead gets an owner, a next step and a deadline
          </p>
        </Halftone>
      </aside>
    </div>
  );
}
