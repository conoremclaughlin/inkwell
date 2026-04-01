import { Suspense } from 'react';
import LoginForm from './login-form';

export const metadata = {
  title: 'Sign In - Inkstand',
};

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}

function AuthFormSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-40 bg-gray-200 rounded" />
        <div className="h-4 w-64 bg-gray-100 rounded" />
      </div>
      <div className="space-y-3">
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
      </div>
      <div className="h-px w-full bg-gray-100" />
      <div className="space-y-4">
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-100 rounded-xl" />
        <div className="h-12 w-full bg-gray-200 rounded-xl" />
      </div>
    </div>
  );
}
