'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2 } from 'lucide-react';
import { useApiQuery, useApiPost, useApiDelete, useQueryClient } from '@/lib/api';

interface TrustedUser {
  id: string;
  platform: string;
  platformUserId: string;
  trustLevel: 'owner' | 'admin' | 'member';
  addedAt: string;
}

interface TrustedUsersResponse {
  users: TrustedUser[];
}

interface AddUserInput {
  platform: string;
  platformUserId: string;
  trustLevel: string;
}

export default function TrustedUsersPage() {
  const queryClient = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUser, setNewUser] = useState<AddUserInput>({
    platform: 'whatsapp',
    platformUserId: '',
    trustLevel: 'member',
  });

  // Fetch users with React Query
  const { data, isLoading, error } = useApiQuery<TrustedUsersResponse>(
    ['trusted-users'],
    '/api/admin/trusted-users'
  );

  // Add user mutation
  const addMutation = useApiPost<TrustedUsersResponse, AddUserInput>('/api/admin/trusted-users', {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trusted-users'] });
      setShowAddForm(false);
      setNewUser({ platform: 'whatsapp', platformUserId: '', trustLevel: 'member' });
    },
  });

  // Delete user mutation
  const deleteMutation = useApiDelete<void>('/api/admin/trusted-users', {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trusted-users'] });
    },
  });

  const handleAddUser = (e: React.FormEvent) => {
    e.preventDefault();
    addMutation.mutate(newUser);
  };

  const handleDeleteUser = (id: string) => {
    if (!confirm('Are you sure you want to remove this trusted user?')) return;
    deleteMutation.mutate(id);
  };

  const users = data?.users ?? [];
  const errorMessage =
    error?.message || addMutation.error?.message || deleteMutation.error?.message;

  const getTrustLevelBadge = (level: string) => {
    switch (level) {
      case 'owner':
        return <Badge variant="default">Owner</Badge>;
      case 'admin':
        return <Badge variant="secondary">Admin</Badge>;
      default:
        return <Badge variant="outline">Member</Badge>;
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Trusted Users</h1>
          <p className="mt-2 text-gray-600">
            Manage users who can interact with Myra in DMs and generate group codes.
          </p>
        </div>
        <Button onClick={() => setShowAddForm(true)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add User
        </Button>
      </div>

      {errorMessage && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{errorMessage}</div>
      )}

      {showAddForm && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Add Trusted User</CardTitle>
            <CardDescription>Add a new user who can interact with Myra.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAddUser} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Platform</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                    value={newUser.platform}
                    onChange={(e) => setNewUser({ ...newUser, platform: e.target.value })}
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="telegram">Telegram</option>
                    <option value="discord">Discord</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">User ID</label>
                  <Input
                    placeholder={
                      newUser.platform === 'whatsapp'
                        ? '+14155551234'
                        : newUser.platform === 'telegram'
                          ? '123456789'
                          : 'discord_user_id'
                    }
                    value={newUser.platformUserId}
                    onChange={(e) => setNewUser({ ...newUser, platformUserId: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Trust Level</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                    value={newUser.trustLevel}
                    onChange={(e) => setNewUser({ ...newUser, trustLevel: e.target.value })}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={addMutation.isPending}>
                  {addMutation.isPending ? 'Adding...' : 'Add User'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Trusted Users</CardTitle>
          <CardDescription>
            {users.length} user{users.length !== 1 ? 's' : ''} configured
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : users.length === 0 ? (
            <p className="text-gray-500">No trusted users configured yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 font-medium">Platform</th>
                    <th className="pb-3 font-medium">User ID</th>
                    <th className="pb-3 font-medium">Trust Level</th>
                    <th className="pb-3 font-medium">Added</th>
                    <th className="pb-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b">
                      <td className="py-3">
                        <Badge variant="outline">{user.platform}</Badge>
                      </td>
                      <td className="py-3 font-mono text-sm">{user.platformUserId}</td>
                      <td className="py-3">{getTrustLevelBadge(user.trustLevel)}</td>
                      <td className="py-3 text-sm text-gray-500">
                        {new Date(user.addedAt).toLocaleDateString()}
                      </td>
                      <td className="py-3">
                        {user.trustLevel !== 'owner' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteUser(user.id)}
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
