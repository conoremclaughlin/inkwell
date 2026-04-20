'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Link2,
  Link2Off,
  Mail,
  AlertCircle,
  CheckCircle,
  Clock,
  RefreshCw,
  MessageSquare,
  ChevronRight,
  Calendar,
  User,
  Shield,
  FolderOpen,
} from 'lucide-react';
import { useApiQuery, useApiDelete, apiGet, apiPost } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState, useEffect, useCallback } from 'react';

interface ConnectedAccount {
  id: string;
  provider: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: 'active' | 'expired' | 'revoked' | 'error';
  lastError: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  scopes: string[];
  createdAt: string;
}

interface Provider {
  name: string;
  configured: boolean;
  connected: boolean;
}

interface ConnectedAccountsResponse {
  accounts: ConnectedAccount[];
  providers: Provider[];
}

interface RequiredScopesResponse {
  provider: string;
  requiredScopes: string[];
}

interface UpgradeScopesResponse {
  needsUpgrade: boolean;
  authUrl?: string;
  missingScopes?: string[];
  currentScopes?: string[];
  message?: string;
}

const providerConfig: Record<
  string,
  { label: string; icon: React.ReactNode; color: string; description: string }
> = {
  google: {
    label: 'Google',
    icon: <Mail className="h-5 w-5" />,
    color: 'text-red-600',
    description: 'Gmail, Calendar, and profile access',
  },
};

const statusConfig = {
  active: {
    label: 'Active',
    icon: CheckCircle,
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
  expired: {
    label: 'Expired',
    icon: Clock,
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-100',
  },
  revoked: {
    label: 'Revoked',
    icon: Link2Off,
    color: 'text-red-600',
    bgColor: 'bg-red-100',
  },
  error: {
    label: 'Error',
    icon: AlertCircle,
    color: 'text-red-600',
    bgColor: 'bg-red-100',
  },
};

// Permission groups for organized display
type PermissionGroup = 'email' | 'calendar' | 'files' | 'profile' | 'other';

interface ScopeInfo {
  label: string;
  group: PermissionGroup;
}

const scopeTranslations: Record<string, ScopeInfo> = {
  'https://www.googleapis.com/auth/gmail.readonly': { label: 'Read emails', group: 'email' },
  'https://www.googleapis.com/auth/gmail.send': { label: 'Send emails', group: 'email' },
  'https://www.googleapis.com/auth/gmail.modify': { label: 'Modify emails', group: 'email' },
  'https://mail.google.com/': { label: 'Full access', group: 'email' },
  'https://www.googleapis.com/auth/calendar.readonly': {
    label: 'View calendar',
    group: 'calendar',
  },
  'https://www.googleapis.com/auth/calendar.events.readonly': {
    label: 'View events',
    group: 'calendar',
  },
  'https://www.googleapis.com/auth/calendar.events': { label: 'Manage events', group: 'calendar' },
  'https://www.googleapis.com/auth/spreadsheets': {
    label: 'Read & edit spreadsheets',
    group: 'files',
  },
  'https://www.googleapis.com/auth/documents': { label: 'Read & edit documents', group: 'files' },
  'https://www.googleapis.com/auth/drive': {
    label: 'Manage Drive files & folders',
    group: 'files',
  },
  'https://www.googleapis.com/auth/drive.file': {
    label: 'Manage app-created Drive files',
    group: 'files',
  },
  'https://www.googleapis.com/auth/userinfo.email': { label: 'Email address', group: 'profile' },
  'https://www.googleapis.com/auth/userinfo.profile': { label: 'Profile info', group: 'profile' },
  openid: { label: 'OpenID', group: 'profile' },
};

const permissionGroups: Record<PermissionGroup, { label: string; icon: React.ReactNode }> = {
  email: { label: 'Email', icon: <Mail className="h-4 w-4" /> },
  calendar: { label: 'Calendar', icon: <Calendar className="h-4 w-4" /> },
  files: { label: 'Docs / Sheets / Drive', icon: <FolderOpen className="h-4 w-4" /> },
  profile: { label: 'Profile', icon: <User className="h-4 w-4" /> },
  other: { label: 'Other', icon: <Shield className="h-4 w-4" /> },
};

function groupScopes(scopes: string[]): Record<PermissionGroup, string[]> {
  const groups: Record<PermissionGroup, string[]> = {
    email: [],
    calendar: [],
    files: [],
    profile: [],
    other: [],
  };

  scopes.forEach((scope) => {
    const info = scopeTranslations[scope];
    if (info) {
      groups[info.group].push(scope);
    } else {
      groups.other.push(scope);
    }
  });

  return groups;
}

function translateScope(scope: string): string {
  const info = scopeTranslations[scope];
  if (info) {
    return info.label;
  }
  // Fallback: simplify the scope URL
  return scope
    .replace('https://www.googleapis.com/auth/', '')
    .replace('https://mail.google.com/', 'gmail.full')
    .replace(/\./g, ' ')
    .replace(/_/g, ' ');
}

function formatRelativeTime(date: string): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now.getTime() - target.getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  return `${diffDays} days ago`;
}

export default function ConnectedAccountsPage() {
  const queryClient = useQueryClient();
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [upgradeAccount, setUpgradeAccount] = useState<ConnectedAccount | null>(null);
  const [missingScopes, setMissingScopes] = useState<string[]>([]);
  const [upgradingScopes, setUpgradingScopes] = useState(false);
  const [requiredScopes, setRequiredScopes] = useState<Record<string, string[]>>({});

  const { data, isLoading, error, refetch } = useApiQuery<ConnectedAccountsResponse>(
    ['connected-accounts'],
    '/api/admin/connected-accounts'
  );

  // Fetch required scopes for each provider
  useEffect(() => {
    const fetchRequiredScopes = async () => {
      try {
        const googleScopes = await apiGet<RequiredScopesResponse>(
          '/api/admin/oauth/google/required-scopes'
        );
        setRequiredScopes((prev) => ({
          ...prev,
          google: googleScopes.requiredScopes,
        }));
      } catch (err) {
        console.error('Failed to fetch required scopes:', err);
      }
    };
    fetchRequiredScopes();
  }, []);

  // Check if an account has missing scopes
  const getMissingScopes = useCallback(
    (account: ConnectedAccount): string[] => {
      const required = requiredScopes[account.provider] || [];
      const current = new Set(account.scopes);
      return required.filter((scope) => !current.has(scope));
    },
    [requiredScopes]
  );

  const disconnectMutation = useApiDelete<{ success: boolean }>('/api/admin/connected-accounts');

  const accounts = data?.accounts ?? [];
  const providers = data?.providers ?? [];

  // Handle OAuth popup callback
  const handleOAuthMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        setConnectingProvider(null);
        if (event.data.success) {
          refetch();
        }
      }
    },
    [refetch]
  );

  useEffect(() => {
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [handleOAuthMessage]);

  const handleConnect = async (provider: string) => {
    setConnectingProvider(provider);

    try {
      // Get the auth URL from the API (using authenticated client)
      const { authUrl } = await apiGet<{ authUrl: string }>(
        `/api/admin/oauth/${provider}/authorize`
      );

      // Open popup for OAuth
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const popup = window.open(
        authUrl,
        'oauth-popup',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      // Check if popup was blocked
      if (!popup) {
        setConnectingProvider(null);
        alert('Popup was blocked. Please allow popups for this site.');
      }
    } catch (err) {
      setConnectingProvider(null);
      console.error('OAuth error:', err);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm('Are you sure you want to disconnect this account?')) {
      return;
    }

    try {
      await disconnectMutation.mutateAsync(accountId);
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] });
    } catch (err) {
      console.error('Disconnect error:', err);
    }
  };

  const handleOpenUpgradeModal = (account: ConnectedAccount) => {
    const missing = getMissingScopes(account);
    setUpgradeAccount(account);
    setMissingScopes(missing);
    setUpgradeModalOpen(true);
  };

  const handleUpgradeScopes = async () => {
    if (!upgradeAccount) return;

    setUpgradingScopes(true);
    try {
      const response = await apiPost<UpgradeScopesResponse>(
        `/api/admin/oauth/${upgradeAccount.provider}/upgrade-scopes`,
        { accountId: upgradeAccount.id }
      );

      if (!response.needsUpgrade) {
        // No upgrade needed - scopes are already up to date
        setUpgradeModalOpen(false);
        refetch();
        return;
      }

      if (response.authUrl) {
        // Open popup for OAuth upgrade
        const width = 500;
        const height = 600;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        const popup = window.open(
          response.authUrl,
          'oauth-upgrade-popup',
          `width=${width},height=${height},left=${left},top=${top}`
        );

        if (!popup) {
          alert('Popup was blocked. Please allow popups for this site.');
        }
      }
    } catch (err) {
      console.error('Upgrade scopes error:', err);
    } finally {
      setUpgradingScopes(false);
      setUpgradeModalOpen(false);
    }
  };

  // Get providers that aren't connected yet
  const availableProviders = providers.filter((p) => {
    const account = accounts.find((a) => a.provider === p.name && a.status === 'active');
    return account === undefined && p.configured;
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Connected Accounts</h1>
          <p className="mt-2 text-gray-600">
            Connect third-party accounts for enhanced integrations (email, calendar, etc.)
          </p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      {/* WhatsApp Connection */}
      <Link href="/connected-accounts/whatsapp" className="block mt-6">
        <Card className="hover:border-green-300 hover:shadow-sm transition-all cursor-pointer">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-green-100 text-green-600">
                  <MessageSquare className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">WhatsApp</h3>
                  <p className="text-sm text-gray-500">
                    Connect via QR code to enable WhatsApp messaging
                  </p>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-gray-400" />
            </div>
          </CardContent>
        </Card>
      </Link>

      {/* Unified Integrations Card */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
          <CardDescription>
            Manage your connected accounts and available integrations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : (
            <div className="space-y-4">
              {/* Connected Accounts */}
              {accounts.map((account) => {
                const providerCfg = providerConfig[account.provider] || {
                  label: account.provider,
                  icon: <Link2 className="h-5 w-5" />,
                  color: 'text-gray-600',
                  description: '',
                };
                const statusCfg = statusConfig[account.status];
                const StatusIcon = statusCfg.icon;

                return (
                  <div
                    key={account.id}
                    className={clsx(
                      'rounded-lg border p-4',
                      account.status === 'active'
                        ? 'border-green-200 bg-green-50/30'
                        : 'border-yellow-200 bg-yellow-50/50'
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4">
                        {account.avatarUrl ? (
                          <img
                            src={account.avatarUrl}
                            alt={account.displayName || ''}
                            className="h-12 w-12 rounded-full"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div
                            className={clsx('p-3 rounded-full bg-white border', providerCfg.color)}
                          >
                            {providerCfg.icon}
                          </div>
                        )}
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-gray-900">
                              {account.displayName || account.email || providerCfg.label}
                            </h3>
                            <Badge className={clsx('text-xs', statusCfg.bgColor, statusCfg.color)}>
                              <StatusIcon className="mr-1 h-3 w-3" />
                              {statusCfg.label}
                            </Badge>
                          </div>
                          {account.email && account.displayName && (
                            <p className="text-sm text-gray-500">{account.email}</p>
                          )}
                          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Connected {new Date(account.createdAt).toLocaleDateString()}
                            </span>
                            {account.lastUsedAt && (
                              <span>Last used: {formatRelativeTime(account.lastUsedAt)}</span>
                            )}
                          </div>
                          {account.lastError && (
                            <p className="text-sm text-red-600 mt-2">
                              <AlertCircle className="inline h-3 w-3 mr-1" />
                              {account.lastError}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {account.status === 'active' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenUpgradeModal(account)}
                          >
                            <Shield className="h-4 w-4" />
                            {getMissingScopes(account).length > 0
                              ? 'Modify Permissions'
                              : 'View Permissions'}
                          </Button>
                        )}
                        {account.status === 'expired' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleConnect(account.provider)}
                          >
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Reconnect
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleDisconnect(account.id)}
                        >
                          <Link2Off className="mr-2 h-4 w-4" />
                          Disconnect
                        </Button>
                      </div>
                    </div>

                    {/* Grouped Permissions */}
                    {account.scopes.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-green-100">
                        <p className="text-xs text-gray-500 mb-3">Permissions granted:</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                          {(
                            Object.entries(groupScopes(account.scopes)) as [
                              PermissionGroup,
                              string[],
                            ][]
                          )
                            .filter(([, scopes]) => scopes.length > 0)
                            .map(([group, scopes]) => {
                              const groupConfig = permissionGroups[group];
                              return (
                                <div key={group} className="bg-gray-50 rounded-lg p-3">
                                  <div className="flex items-center gap-2 text-gray-700 mb-2">
                                    {groupConfig.icon}
                                    <span className="text-sm font-medium">{groupConfig.label}</span>
                                  </div>
                                  <div className="space-y-1">
                                    {scopes.map((scope) => (
                                      <div
                                        key={scope}
                                        className="flex items-center gap-2 text-xs text-gray-600"
                                      >
                                        <CheckCircle className="h-3 w-3 text-green-500" />
                                        {translateScope(scope)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Divider if both sections have content */}
              {accounts.length > 0 && availableProviders.length > 0 && (
                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-200" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-white px-3 text-xs text-gray-500">
                      Available to connect
                    </span>
                  </div>
                </div>
              )}

              {/* Available Providers */}
              {availableProviders.map((provider) => {
                const config = providerConfig[provider.name] || {
                  label: provider.name,
                  icon: <Link2 className="h-5 w-5" />,
                  color: 'text-gray-600',
                  description: 'Connect this service',
                };

                return (
                  <div key={provider.name} className="rounded-lg border border-gray-200 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={clsx('p-3 rounded-lg bg-gray-50 border', config.color)}>
                          {config.icon}
                        </div>
                        <div>
                          <h3 className="font-medium text-gray-900">{config.label}</h3>
                          <p className="text-sm text-gray-500">{config.description}</p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleConnect(provider.name)}
                        disabled={connectingProvider === provider.name}
                      >
                        {connectingProvider === provider.name ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          <>
                            <Link2 className="mr-2 h-4 w-4" />
                            Connect
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}

              {/* Empty state */}
              {accounts.length === 0 && availableProviders.length === 0 && (
                <div className="text-center py-8">
                  <Link2Off className="h-12 w-12 mx-auto text-gray-300 mb-3" />
                  <p className="text-gray-500">No integrations available.</p>
                  <p className="text-sm text-gray-400 mt-1">
                    Configure OAuth credentials in your environment to enable integrations.
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modify Permissions Modal */}
      <Dialog open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-gray-600" />
              Modify Permissions
            </DialogTitle>
            <DialogDescription>
              Manage permissions for your{' '}
              {upgradeAccount?.provider === 'google' ? 'Google' : upgradeAccount?.provider} account.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-5">
            {/* Current Permissions Section */}
            {upgradeAccount && upgradeAccount.scopes.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  Current Permissions
                </h4>
                <div className="bg-green-50 rounded-lg p-3 border border-green-100">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(
                      Object.entries(groupScopes(upgradeAccount.scopes)) as [
                        PermissionGroup,
                        string[],
                      ][]
                    )
                      .filter(([, scopes]) => scopes.length > 0)
                      .map(([group, scopes]) => {
                        const groupConfig = permissionGroups[group];
                        return (
                          <div key={group}>
                            <div className="flex items-center gap-2 text-gray-700 mb-1">
                              {groupConfig.icon}
                              <span className="text-xs font-medium">{groupConfig.label}</span>
                            </div>
                            <div className="space-y-1">
                              {scopes.map((scope) => (
                                <div
                                  key={scope}
                                  className="flex items-center gap-2 text-xs text-gray-600"
                                >
                                  <CheckCircle className="h-3 w-3 text-green-500" />
                                  {translateScope(scope)}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>
            )}

            {/* Available to Add Section */}
            {missingScopes.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-500" />
                  Available to Add
                </h4>
                <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(Object.entries(groupScopes(missingScopes)) as [PermissionGroup, string[]][])
                      .filter(([, scopes]) => scopes.length > 0)
                      .map(([group, scopes]) => {
                        const groupConfig = permissionGroups[group];
                        return (
                          <div key={group}>
                            <div className="flex items-center gap-2 text-gray-700 mb-1">
                              {groupConfig.icon}
                              <span className="text-xs font-medium">{groupConfig.label}</span>
                            </div>
                            <div className="space-y-1">
                              {scopes.map((scope) => (
                                <div
                                  key={scope}
                                  className="flex items-center gap-2 text-xs text-gray-600"
                                >
                                  <div className="h-3 w-3 rounded border border-blue-400 bg-white" />
                                  {translateScope(scope)}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Click &quot;Add Permissions&quot; to authorize these additional permissions via
                  Google.
                </p>
              </div>
            )}

            {/* Note about removing permissions */}
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
              <p className="text-xs text-gray-500">
                <strong className="text-gray-600">Note:</strong> To remove permissions, you must
                disconnect this account and reconnect with only the permissions you need. Google
                does not support revoking individual scopes.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setUpgradeModalOpen(false)}
              disabled={upgradingScopes}
            >
              Close
            </Button>
            {missingScopes.length > 0 && (
              <Button onClick={handleUpgradeScopes} disabled={upgradingScopes}>
                {upgradingScopes ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Authorizing...
                  </>
                ) : (
                  <>
                    <Shield className="mr-2 h-4 w-4" />
                    Add Permissions
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
