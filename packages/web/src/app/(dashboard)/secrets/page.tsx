'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Lock, Plus, Trash2, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { useApiQuery, useApiPost, useApiDelete, useQueryClient } from '@/lib/api';

interface Secret {
  name: string;
  label: string;
  createdAt: string | null;
  modifiedAt: string | null;
}

interface SecretsResponse {
  secrets: Secret[];
}

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function SecretsPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [formError, setFormError] = useState('');

  const { data, isLoading, error } = useApiQuery<SecretsResponse>(
    ['secrets'],
    '/api/admin/secrets'
  );

  const createMutation = useApiPost<
    { success: boolean; name: string },
    { name: string; value: string; label?: string }
  >('/api/admin/secrets', {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
      setShowForm(false);
      setName('');
      setValue('');
      setLabel('');
      setFormError('');
    },
    onError: (err: Error) => {
      setFormError(err.message || 'Failed to save secret');
    },
  });

  const deleteMutation = useApiDelete<{ success: boolean }>('/api/admin/secrets', {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
    },
  });

  const secrets = useMemo(() => data?.secrets ?? [], [data]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!name.trim() || !value.trim()) {
      setFormError('Name and value are required');
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      setFormError(
        'Name must start with a letter and contain only letters, numbers, hyphens, underscores'
      );
      return;
    }
    createMutation.mutate({
      name: name.trim(),
      value: value.trim(),
      label: label.trim() || undefined,
    });
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <Lock className="h-8 w-8 text-gray-400" />
            Secrets
          </h1>
          <p className="mt-1 text-gray-500">
            Credentials stored in macOS Keychain. Referenced as{' '}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-sm font-mono">$NAME</code> in
            tool call parameters.
          </p>
        </div>
        <Button
          onClick={() => setShowForm(!showForm)}
          size="sm"
          variant={showForm ? 'outline' : 'default'}
        >
          <Plus className="mr-2 h-4 w-4" />
          {showForm ? 'Cancel' : 'Add Secret'}
        </Button>
      </div>

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-gray-400" />
              <span className="text-sm text-gray-500">Total</span>
            </div>
            <p className="mt-1 text-2xl font-semibold">{secrets.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-green-500" />
              <span className="text-sm text-gray-500">Storage</span>
            </div>
            <p className="mt-1 text-sm font-medium text-green-700">macOS Keychain</p>
          </CardContent>
        </Card>
      </div>

      {/* Create Form */}
      {showForm && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-lg">Add Secret</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="GFIBER_PASSWORD"
                    className="font-mono"
                    autoFocus
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    Referenced as{' '}
                    <code className="bg-gray-100 px-1 rounded">${name || 'NAME'}</code> in tool
                    calls
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Google Fiber password (optional)"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Value</label>
                <div className="relative">
                  <Input
                    type={showValue ? 'text' : 'password'}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="••••••••"
                    className="pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowValue(!showValue)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Saving...' : 'Save to Keychain'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && (
        <div className="mt-6 rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          Failed to load secrets: {error.message}
        </div>
      )}

      {/* Secrets List */}
      <div className="mt-6 space-y-2">
        {isLoading && <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>}
        {!isLoading && secrets.length === 0 && !showForm && (
          <div className="text-center py-12">
            <Lock className="mx-auto h-12 w-12 text-gray-300" />
            <p className="mt-3 text-sm text-gray-500">No secrets stored yet</p>
            <p className="mt-1 text-xs text-gray-400">
              Secrets are stored in macOS Keychain and referenced as $NAME in agent tool calls
            </p>
            <Button onClick={() => setShowForm(true)} size="sm" className="mt-4">
              <Plus className="mr-2 h-4 w-4" />
              Add your first secret
            </Button>
          </div>
        )}
        {secrets.map((secret) => (
          <Card key={secret.name} className="group">
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3 min-w-0">
                <KeyRound className="h-4 w-4 text-gray-400 shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono font-medium text-gray-900">
                      {secret.name}
                    </code>
                    <Badge variant="outline" className="text-xs">
                      ${secret.name}
                    </Badge>
                  </div>
                  {secret.label !== secret.name && (
                    <p className="text-xs text-gray-500 truncate">{secret.label}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs text-gray-400">{formatDate(secret.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteMutation.mutate(secret.name)}
                  disabled={deleteMutation.isPending}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Info */}
      {secrets.length > 0 && (
        <div className="mt-8 rounded-lg bg-gray-50 border border-gray-200 p-4">
          <h3 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-green-500" />
            How credentials work
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            <li>
              Agents reference credentials as{' '}
              <code className="bg-gray-100 px-1 rounded">$NAME</code> in tool call parameters
            </li>
            <li>
              The actual value is injected at the Ink execution layer — it never enters the LLM
              context or transcripts
            </li>
            <li>Credentials are stored in macOS Keychain with AES-256 encryption</li>
          </ul>
        </div>
      )}
    </div>
  );
}
