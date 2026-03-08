'use client';

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type PermissionEditMode = 'workspace' | 'editors';

export interface PermissionIdentityOption {
  id: string;
  name: string;
}

interface ObjectPermissionsEditorProps {
  title?: string;
  description?: string;
  mode: PermissionEditMode;
  onModeChange: (mode: PermissionEditMode) => void;
  editorIdentityIds: string[];
  onEditorIdentityIdsChange: (next: string[]) => void;
  identities: PermissionIdentityOption[];
  actionLabel: string;
  pendingActionLabel?: string;
  onAction: () => void;
  isActionPending?: boolean;
  error?: string | null;
  success?: string | null;
}

export function ObjectPermissionsEditor({
  title = 'Edit permissions',
  description = 'Choose whether anyone in this workspace can edit, or only selected editors.',
  mode,
  onModeChange,
  editorIdentityIds,
  onEditorIdentityIdsChange,
  identities,
  actionLabel,
  pendingActionLabel,
  onAction,
  isActionPending = false,
  error,
  success,
}: ObjectPermissionsEditorProps) {
  const [nextEditorId, setNextEditorId] = useState('');

  const identitiesById = useMemo(
    () => new Map(identities.map((identity) => [identity.id, identity])),
    [identities]
  );

  const availableIdentities = useMemo(
    () => identities.filter((identity) => !editorIdentityIds.includes(identity.id)),
    [editorIdentityIds, identities]
  );

  const addEditor = () => {
    if (!nextEditorId) return;
    if (editorIdentityIds.includes(nextEditorId)) {
      setNextEditorId('');
      return;
    }
    onEditorIdentityIdsChange([...editorIdentityIds, nextEditorId]);
    setNextEditorId('');
  };

  const removeEditor = (identityId: string) => {
    onEditorIdentityIdsChange(editorIdentityIds.filter((current) => current !== identityId));
  };

  const submitDisabled = isActionPending || (mode === 'editors' && editorIdentityIds.length === 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500">{description}</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Access mode</label>
        <select
          value={mode}
          onChange={(event) => onModeChange(event.target.value as PermissionEditMode)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm md:max-w-sm"
        >
          <option value="workspace">Anyone in workspace can edit</option>
          <option value="editors">Only selected editors can edit</option>
        </select>
      </div>

      {mode === 'editors' ? (
        <div className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-gray-700">Add editor</label>
              <select
                value={nextEditorId}
                onChange={(event) => setNextEditorId(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select a person…</option>
                {availableIdentities.map((identity) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" variant="outline" onClick={addEditor} disabled={!nextEditorId}>
              Add editor
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Selected editors
            </p>
            {editorIdentityIds.length === 0 ? (
              <p className="text-sm text-red-700">Select at least one editor.</p>
            ) : (
              <div className="space-y-2">
                {editorIdentityIds.map((identityId) => {
                  const identity = identitiesById.get(identityId);
                  return (
                    <div
                      key={identityId}
                      className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800"
                    >
                      <span>{identity?.name || 'Unknown identity'}</span>
                      <button
                        type="button"
                        onClick={() => removeEditor(identityId)}
                        className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                        aria-label={`Remove ${identity ? identity.name : identityId}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <p>Anyone in this workspace can edit.</p>
          {editorIdentityIds.length > 0 ? (
            <p className="mt-1 text-blue-800">
              Saved editor list ({editorIdentityIds.length}) is preserved if you switch back.
            </p>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onAction} disabled={submitDisabled}>
          {isActionPending ? pendingActionLabel || `${actionLabel}…` : actionLabel}
        </Button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {success ? <p className="text-sm text-green-700">{success}</p> : null}
    </div>
  );
}
