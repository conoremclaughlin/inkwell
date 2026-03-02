'use client';

import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import { ArrowLeft, History, Loader2, Shield, Sparkles, User, Workflow } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApiQuery } from '@/lib/api';
import { normalizeDocMarkdown } from '@/lib/markdown/normalize-doc';

interface UserIdentity {
  id: string;
  userId: string;
  userProfile?: string;
  sharedValues?: string;
  process?: string;
  // Deprecated aliases kept for compatibility during migration
  userProfileMd?: string;
  sharedValuesMd?: string;
  processMd?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface UserIdentityResponse {
  userIdentity: UserIdentity | null;
}

function SharedDocumentPanel({
  title,
  subtitle,
  icon,
  content,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  content?: string;
}) {
  return (
    <Card className="overflow-hidden border-gray-200">
      <CardHeader className="border-b bg-gray-50/60">
        <CardTitle className="flex items-center gap-2 text-lg text-gray-900">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        {content?.trim() ? (
          <div className="prose prose-sm max-w-none text-gray-700">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm italic text-gray-500">No document saved yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SharedDocumentsPage() {
  const { data, isLoading, error } = useApiQuery<UserIdentityResponse>(
    ['user-identity'],
    '/api/admin/user-identity'
  );

  const userIdentity = data?.userIdentity;
  const userProfile = userIdentity?.userProfile ?? userIdentity?.userProfileMd;
  const sharedValues = userIdentity?.sharedValues ?? userIdentity?.sharedValuesMd;
  const process = userIdentity?.process ?? userIdentity?.processMd;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading shared documents...
      </div>
    );
  }

  if (error) {
    return <div className="rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>;
  }

  if (!userIdentity) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-yellow-800">
        No shared documents found yet. Save them with <code>save_user_identity</code>.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-gray-500">
            <Link href="/individuals">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to Individuals
            </Link>
          </Button>
          <h1 className="text-3xl font-bold text-gray-900">Shared context</h1>
          <p className="mt-2 text-gray-600">
            Shared documents across the full SB family: user profile, values, and process.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="bg-indigo-100 text-indigo-700">
            v{userIdentity.version}
          </Badge>
          <Button variant="outline" asChild>
            <Link href="/individuals/shared/versions">
              <History className="mr-1 h-4 w-4" />
              Version history
            </Link>
          </Button>
        </div>
      </div>

      <Tabs defaultValue="user" className="w-full">
        <TabsList className="grid h-auto w-full grid-cols-3 gap-2 bg-transparent p-0">
          <TabsTrigger
            value="user"
            className="border bg-white data-[state=active]:border-blue-300 data-[state=active]:bg-blue-50"
          >
            <User className="mr-2 h-4 w-4" />
            About you
          </TabsTrigger>
          <TabsTrigger
            value="values"
            className="border bg-white data-[state=active]:border-amber-300 data-[state=active]:bg-amber-50"
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Shared values
          </TabsTrigger>
          <TabsTrigger
            value="process"
            className="border bg-white data-[state=active]:border-emerald-300 data-[state=active]:bg-emerald-50"
          >
            <Workflow className="mr-2 h-4 w-4" />
            Process
          </TabsTrigger>
        </TabsList>

        <TabsContent value="user" className="mt-4">
          <SharedDocumentPanel
            title="About you"
            subtitle="User profile"
            icon={<User className="h-5 w-5 text-blue-600" />}
            content={normalizeDocMarkdown(userProfile)}
          />
        </TabsContent>

        <TabsContent value="values" className="mt-4">
          <SharedDocumentPanel
            title="Shared values"
            subtitle="Cross-agent principles"
            icon={<Sparkles className="h-5 w-5 text-amber-600" />}
            content={normalizeDocMarkdown(sharedValues)}
          />
        </TabsContent>

        <TabsContent value="process" className="mt-4">
          <SharedDocumentPanel
            title="Collaboration process"
            subtitle="How we operate"
            icon={<Workflow className="h-5 w-5 text-emerald-600" />}
            content={normalizeDocMarkdown(process)}
          />
        </TabsContent>
      </Tabs>

      <Card className="border-indigo-200 bg-indigo-50/40">
        <CardContent className="flex items-start gap-3 p-4 text-sm text-indigo-900">
          <Shield className="mt-0.5 h-4 w-4" />
          These are product-level shared docs. Individual constitutions and operating guides live on
          each SB profile.
        </CardContent>
      </Card>
    </div>
  );
}
