'use client';

import dynamic from 'next/dynamic';

const CommandCenter = dynamic(
  () => import('@/components/command/command-center').then((m) => m.CommandCenter),
  { ssr: false }
);

export default function CommandPage() {
  return (
    <div className="-m-8 h-[calc(100vh)]">
      <CommandCenter />
    </div>
  );
}
