import { redirect } from 'next/navigation';

// The marketing landing page arrives in Phase 7. Until then the root opens the product.
export default function Home() {
  redirect('/app');
}
