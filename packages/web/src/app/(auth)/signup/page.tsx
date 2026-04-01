import { Suspense } from 'react';
import SignupForm from './signup-form';

export const metadata = {
  title: 'Sign Up - Inkstand',
};

export default function SignupPage() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <SignupForm />
    </Suspense>
  );
}

function AuthFormSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-48 bg-gray-200 rounded" />
        <div className="h-4 w-56 bg-gray-100 rounded" />
      </div>
      <div className="space-y-3">
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
      </div>
      <div className="h-px w-full bg-gray-100" />
      <div className="space-y-4">
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-200 rounded-xl" />
      </div>
    </div>
  );
}
