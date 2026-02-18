/**
 * Admin REST API Routes
 *
 * Provides HTTP endpoints for the PCP Admin Dashboard to manage:
 * - Trusted users
 * - Authorized groups
 * - Challenge codes
 * - WhatsApp connection status and QR codes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getAuthorizationService } from '../services/authorization';
import { getOAuthService } from '../services/oauth';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { runWithRequestContext } from '../utils/request-context';
import { getDataComposer } from '../data/composer';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { WorkspaceMemberRole } from '../data/repositories/workspace-containers.repository';
import { slugifyWorkspaceName } from '../utils/workspace-slug';
import {
  signPcpAccessToken,
  verifyPcpAccessToken,
  createRefreshToken,
  exchangeRefreshToken,
} from '../auth/pcp-tokens';
import type { Database } from '../data/supabase/types';

// WhatsApp listener reference (set via setWhatsAppListener)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whatsAppListener: any = null;

type AdminAuthRequest = Request & {
  user: { email?: string | null };
  pcpUserId: string;
  pcpWorkspaceId: string;
  pcpWorkspaceRole: WorkspaceMemberRole | 'trusted';
};

type CommentAuthorUser = {
  id: string;
  first_name: string | null;
  username: string | null;
  email: string | null;
};

const ADMIN_ACCESS_TOKEN_LIFETIME_SECONDS = 3600; // 1 hour
const ADMIN_REFRESH_TOKEN_LIFETIME_DAYS = 90;
const ADMIN_CLIENT_ID = 'dashboard';
const DEFAULT_SESSION_LOG_LIMIT = 50;
const MAX_SESSION_LOG_LIMIT = 200;
const ACTIVITY_PREVIEW_LIMIT_PER_SESSION = 3;
const LOCAL_TRANSCRIPT_LINE_LIMIT = 200;

function formatCommentAuthorUserName(user: CommentAuthorUser | null): string | null {
  if (!user) return null;
  if (user.first_name?.trim()) return user.first_name.trim();
  if (user.username?.trim()) return user.username.trim();
  if (user.email?.trim()) return user.email.trim();
  return null;
}

type SessionPreviewItem = {
  id: string;
  source: 'activity_stream' | 'session_logs' | 'local_transcript';
  type: string;
  role: 'in' | 'out' | 'system';
  content: string;
  timestamp: string;
};

type SessionLogItem = SessionPreviewItem & {
  metadata?: Record<string, unknown>;
};

function truncateText(input: string, max = 280): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function pickContentFromUnknown(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    const text = input
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join(' ');
    return text;
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const directCandidates = [
      obj.content,
      obj.message,
      obj.text,
      obj.output,
      obj.input,
      obj.summary,
      obj.delta,
      obj.reasoning,
      obj.response,
      obj.body,
    ];
    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
      if (Array.isArray(candidate)) {
        const parts = candidate
          .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
          .join(' ');
        if (parts.trim()) return parts;
      }
      if (candidate && typeof candidate === 'object') {
        const nested = pickContentFromUnknown(candidate);
        if (nested) return nested;
      }
    }
    return JSON.stringify(obj);
  }
  return String(input);
}

function roleFromActivityType(type: string): 'in' | 'out' | 'system' {
  if (type === 'message_in') return 'in';
  if (type === 'message_out') return 'out';
  return 'system';
}

function toActivityLogItem(row: {
  id: string;
  type: string;
  subtype: string | null;
  content: string;
  created_at: string;
  payload: unknown;
}): SessionLogItem {
  const fallbackContent = row.content || '';
  const payloadContent = pickContentFromUnknown(row.payload);
  const combined = payloadContent || fallbackContent;

  return {
    id: `activity:${row.id}`,
    source: 'activity_stream',
    type: row.subtype || row.type,
    role: roleFromActivityType(row.type),
    content: truncateText(combined),
    timestamp: row.created_at,
    metadata: row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : undefined,
  };
}

function toSessionLogItem(row: {
  id: string;
  content: string;
  salience: string;
  created_at: string;
}): SessionLogItem {
  return {
    id: `session_log:${row.id}`,
    source: 'session_logs',
    type: `log:${row.salience}`,
    role: 'system',
    content: truncateText(row.content || ''),
    timestamp: row.created_at,
  };
}

async function findTranscriptFile(
  rootDir: string,
  targetFileName: string,
  maxDepth: number
): Promise<string | null> {
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > maxDepth) return null;
    let entries: Array<{
      name: string;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }>;
    try {
      entries = (await fs.readdir(dir, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as unknown as Array<{
        name: string;
        isFile: () => boolean;
        isDirectory: () => boolean;
      }>;
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === targetFileName) return fullPath;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const found = await walk(fullPath, depth + 1);
      if (found) return found;
    }

    return null;
  }

  return walk(rootDir, 0);
}

async function tryReadLocalTranscript(
  backendSessionId: string | null,
  backend: string | null
): Promise<SessionLogItem[]> {
  if (!backendSessionId) return [];

  const transcriptFileName = `${backendSessionId}.jsonl`;
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  if (backend?.toLowerCase().includes('codex')) {
    roots.push(path.join(os.homedir(), '.codex', 'sessions'));
    roots.push(path.join(os.homedir(), '.codex', 'projects'));
  }

  let transcriptPath: string | null = null;
  for (const root of roots) {
    transcriptPath = await findTranscriptFile(root, transcriptFileName, 5);
    if (transcriptPath) break;
  }
  if (!transcriptPath) return [];

  let fileContent = '';
  try {
    fileContent = await fs.readFile(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const lines = fileContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const recent = lines.slice(-LOCAL_TRANSCRIPT_LINE_LIMIT);
  const items: SessionLogItem[] = [];

  for (let i = 0; i < recent.length; i++) {
    const line = recent[i];
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const timestampCandidate =
        parsed.timestamp ||
        parsed.created_at ||
        parsed.createdAt ||
        parsed.time ||
        parsed.ts ||
        null;
      const timestamp =
        typeof timestampCandidate === 'string' && timestampCandidate
          ? timestampCandidate
          : new Date(0).toISOString();

      const rawType =
        (typeof parsed.type === 'string' && parsed.type) ||
        (typeof parsed.event === 'string' && parsed.event) ||
        'local';
      const role: 'in' | 'out' | 'system' =
        rawType.includes('user') || rawType.includes('input')
          ? 'in'
          : rawType.includes('assistant') || rawType.includes('output')
            ? 'out'
            : 'system';

      const content = truncateText(pickContentFromUnknown(parsed));
      if (!content) continue;

      items.push({
        id: `local:${i}`,
        source: 'local_transcript',
        type: rawType,
        role,
        content,
        timestamp,
        metadata: {
          path: transcriptPath,
        },
      });
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

async function fetchCloudSessionLogs(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string
): Promise<SessionLogItem[]> {
  const [{ data: activityRows }, { data: sessionLogRows }] = await Promise.all([
    supabase
      .from('activity_stream')
      .select('id, type, subtype, content, created_at, payload')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(2000),
    supabase
      .from('session_logs')
      .select('id, content, salience, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);

  const activityItems = (activityRows || []).map(toActivityLogItem);
  const sessionItems = (sessionLogRows || [])
    .filter(
      (
        row
      ): row is { id: string; content: string; salience: string; created_at: string } =>
        typeof row.created_at === 'string' && row.created_at.length > 0
    )
    .map(toSessionLogItem);

  return [...activityItems, ...sessionItems].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Set the WhatsApp listener for admin endpoints
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setWhatsAppListener(listener: any): void {
  whatsAppListener = listener;
}

/**
 * Admin auth middleware — three-tier verification:
 *
 * Tier 1: PCP admin access JWT (local jwt.verify, ~0ms)
 * Tier 2: Refresh token exchange (1 DB call, ~once/hour)
 * Tier 3: Supabase verification (network call, first login only)
 *
 * Skips authentication for OAuth callback routes (they use state tokens).
 */
async function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Skip auth for OAuth callbacks (they use state tokens for security)
  if (req.path.match(/\/oauth\/[^/]+\/callback$/)) {
    next();
    return;
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let pcpUserId: string | undefined;
    let userEmail: string | undefined;
    let issueTokenCookies = false;

    // --- Tier 1: PCP admin access JWT (local, ~0ms) ---
    const payload = verifyPcpAccessToken(token, 'pcp_admin');
    if (payload) {
      pcpUserId = payload.sub;
      userEmail = payload.email;
    }

    // --- Tier 2: Refresh token exchange (1 DB call, ~once/hour) ---
    if (!pcpUserId) {
      const refreshCookie = req.cookies?.['pcp-admin-refresh'];
      if (refreshCookie) {
        const result = await exchangeRefreshToken(
          supabase,
          refreshCookie,
          ADMIN_CLIENT_ID,
          'pcp_admin',
          ADMIN_ACCESS_TOKEN_LIFETIME_SECONDS
        );
        if (result) {
          pcpUserId = result.userId;
          userEmail = result.email;
          // Set new access token cookie (refresh token stays the same)
          res.cookie('pcp-admin-token', result.accessToken, {
            httpOnly: true,
            secure: env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/api/admin',
            maxAge: ADMIN_ACCESS_TOKEN_LIFETIME_SECONDS * 1000,
          });
        }
      }
    }

    // --- Tier 3: Supabase verification (network call, first login only) ---
    if (!pcpUserId) {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(token);

      if (error || !user) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      // Look up (or create) PCP user by email.
      const normalizedEmail = user.email?.toLowerCase() ?? null;
      let { data: pcpUser } = await supabase
        .from('users')
        .select('id, telegram_id, whatsapp_id')
        .eq('email', normalizedEmail)
        .single();

      if (!pcpUser) {
        if (!normalizedEmail) {
          res.status(403).json({ error: 'User email not available for PCP provisioning' });
          return;
        }

        const { data: createdUser, error: createUserError } = await supabase
          .from('users')
          .insert({ email: normalizedEmail, last_login_at: new Date().toISOString() })
          .select('id, telegram_id, whatsapp_id')
          .single();

        if (createUserError) {
          const { data: racedUser } = await supabase
            .from('users')
            .select('id, telegram_id, whatsapp_id')
            .eq('email', normalizedEmail)
            .single();

          if (!racedUser) {
            logger.error('Failed to auto-provision PCP user during admin auth', {
              email: normalizedEmail,
              error: createUserError.message,
            });
            res.status(500).json({ error: 'Failed to provision PCP user' });
            return;
          }

          pcpUser = racedUser;
        } else {
          pcpUser = createdUser;
        }
      }

      // Update last_login_at — Tier 3 only runs on actual login (Supabase token verification)
      await supabase
        .from('users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', pcpUser.id);

      pcpUserId = pcpUser.id;
      userEmail = normalizedEmail || user.email || undefined;
      issueTokenCookies = true;
    }

    // --- Workspace resolution (all tiers, 1 DB query) ---
    const dataComposer = await getDataComposer();
    const workspaceRepo = dataComposer.repositories.workspaceContainers;
    const requestedWorkspaceId = req.header('x-pcp-workspace-id')?.trim();

    // For trusted-user resolution we need telegram/whatsapp IDs.
    // Tier 1/2 don't have them in JWT claims, so fetch when needed.
    let pcpUserRecord: {
      id: string;
      telegram_id: string | null;
      whatsapp_id: string | null;
    } | null = null;

    const getPcpUserRecord = async () => {
      if (!pcpUserRecord) {
        const { data } = await supabase
          .from('users')
          .select('id, telegram_id, whatsapp_id')
          .eq('id', pcpUserId!)
          .single();
        pcpUserRecord = data;
      }
      return pcpUserRecord;
    };

    const hasTrustedAdminAccess = async (workspaceId: string): Promise<boolean> => {
      const record = await getPcpUserRecord();
      if (!record) return false;

      const authService = getAuthorizationService();
      const trustedUsers = await authService.listTrustedUsers(undefined, workspaceId);

      return trustedUsers.some((tu) => {
        if (tu.trustLevel === 'member') return false;
        if (tu.userId === record.id) return true;
        if (tu.platform === 'telegram' && record.telegram_id?.toString() === tu.platformUserId) {
          return true;
        }
        if (tu.platform === 'whatsapp' && record.whatsapp_id === tu.platformUserId) {
          return true;
        }
        return false;
      });
    };

    let activeWorkspaceId = '';
    let activeWorkspaceRole: WorkspaceMemberRole | 'trusted' = 'trusted';
    let hasDirectMembership = false;

    if (requestedWorkspaceId) {
      const requestedWorkspace = await workspaceRepo.findById(requestedWorkspaceId, pcpUserId!);
      if (requestedWorkspace) {
        activeWorkspaceId = requestedWorkspace.id;
        hasDirectMembership = true;
      } else {
        const requestedWorkspaceExists = await workspaceRepo.findRawById(requestedWorkspaceId);
        if (!requestedWorkspaceExists) {
          res.status(404).json({ error: 'Workspace not found' });
          return;
        }

        const trustedForRequestedWorkspace = await hasTrustedAdminAccess(requestedWorkspaceId);
        if (!trustedForRequestedWorkspace) {
          res.status(403).json({ error: 'Workspace not found or not accessible' });
          return;
        }

        activeWorkspaceId = requestedWorkspaceId;
        activeWorkspaceRole = 'trusted';
      }
    } else {
      const personalWorkspace = await workspaceRepo.ensurePersonalWorkspace(pcpUserId!);
      activeWorkspaceId = personalWorkspace.id;
      hasDirectMembership = true;
    }

    if (!hasDirectMembership) {
      const trustedForActiveWorkspace = await hasTrustedAdminAccess(activeWorkspaceId);
      if (!trustedForActiveWorkspace) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    if (hasDirectMembership) {
      activeWorkspaceRole = 'member';
    }

    // --- Issue cookies (Tier 3 success) ---
    if (issueTokenCookies && pcpUserId && userEmail) {
      const accessToken = signPcpAccessToken(
        { type: 'pcp_admin', sub: pcpUserId, email: userEmail, scope: 'admin' },
        ADMIN_ACCESS_TOKEN_LIFETIME_SECONDS
      );
      try {
        const { refreshToken } = await createRefreshToken(
          supabase,
          pcpUserId,
          ADMIN_CLIENT_ID,
          ['admin'],
          ADMIN_REFRESH_TOKEN_LIFETIME_DAYS
        );
        res.cookie('pcp-admin-token', accessToken, {
          httpOnly: true,
          secure: env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/api/admin',
          maxAge: ADMIN_ACCESS_TOKEN_LIFETIME_SECONDS * 1000,
        });
        res.cookie('pcp-admin-refresh', refreshToken, {
          httpOnly: true,
          secure: env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/api/admin',
          maxAge: ADMIN_REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
        });
      } catch (cookieError) {
        // Non-fatal: auth succeeded, just couldn't issue PCP cookies.
        // Next request will hit Tier 3 again.
        logger.warn('Failed to issue PCP admin cookies', { error: cookieError });
      }
    }

    // Attach user + PCP context to request
    const authReq = req as AdminAuthRequest;
    authReq.user = { email: userEmail || null };
    authReq.pcpUserId = pcpUserId!;
    authReq.pcpWorkspaceId = activeWorkspaceId;
    authReq.pcpWorkspaceRole = activeWorkspaceRole || 'trusted';

    // Wrap the rest of the request in context
    runWithRequestContext(
      {
        userId: pcpUserId!,
        email: userEmail,
        workspaceId: activeWorkspaceId,
      },
      () => next()
    );
  } catch (error) {
    logger.error('Admin auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

const router = Router();

// =============================================================================
// Auth Logout (before auth middleware — doesn't require active session)
// =============================================================================

/**
 * POST /api/admin/auth/logout
 * Revoke PCP admin refresh token and clear auth cookies.
 * Accepts refresh token via request body (server action) or cookie (direct browser call).
 */
router.post('/auth/logout', async (req: Request, res: Response) => {
  try {
    const refreshToken = req.body?.refreshToken || req.cookies?.['pcp-admin-refresh'];

    if (refreshToken) {
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      await supabase
        .from('mcp_tokens')
        .delete()
        .eq('refresh_token', refreshToken)
        .eq('client_id', ADMIN_CLIENT_ID);
    }

    // Clear cookies regardless (same options used when setting them)
    res.clearCookie('pcp-admin-token', { path: '/api/admin' });
    res.clearCookie('pcp-admin-refresh', { path: '/api/admin' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Admin logout error:', error);
    // Still clear cookies even if DB revocation fails
    res.clearCookie('pcp-admin-token', { path: '/api/admin' });
    res.clearCookie('pcp-admin-refresh', { path: '/api/admin' });
    res.json({ success: true });
  }
});

// Apply auth middleware to all subsequent routes
router.use(adminAuthMiddleware);

// =============================================================================
// Workspace Containers
// =============================================================================

/**
 * GET /api/admin/workspaces
 * List workspace containers available to the authenticated user.
 */
router.get('/workspaces', async (req: Request, res: Response) => {
  try {
    const authReq = req as AdminAuthRequest;
    const dataComposer = await getDataComposer();
    const workspaceRepo = dataComposer.repositories.workspaceContainers;
    const workspaces = await workspaceRepo.listMembershipsByUser(authReq.pcpUserId, {
      includeArchived: false,
    });

    const currentWorkspaceMembership = workspaces.find(
      (workspace) => workspace.id === authReq.pcpWorkspaceId
    );
    const currentWorkspaceRole = currentWorkspaceMembership?.role || authReq.pcpWorkspaceRole;

    res.json({
      currentWorkspaceId: authReq.pcpWorkspaceId,
      currentWorkspaceRole,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        type: w.type,
        role: w.role,
        membershipCreatedAt: w.membershipCreatedAt,
        description: w.description,
        metadata: w.metadata,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        archivedAt: w.archivedAt,
      })),
    });
  } catch (error) {
    logger.error('Failed to list workspace containers:', error);
    res.status(500).json({ error: 'Failed to list workspace containers' });
  }
});

/**
 * POST /api/admin/workspaces
 * Create a new workspace container and make the caller owner.
 */
router.post('/workspaces', async (req: Request, res: Response) => {
  try {
    const authReq = req as AdminAuthRequest;
    const dataComposer = await getDataComposer();
    const workspaceRepo = dataComposer.repositories.workspaceContainers;

    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!rawName) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const rawType = req.body?.type;
    const workspaceType = rawType === 'team' ? 'team' : 'personal';
    const workspaceDescription =
      typeof req.body?.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : undefined;
    const workspaceSlug =
      typeof req.body?.slug === 'string' && req.body.slug.trim()
        ? slugifyWorkspaceName(req.body.slug)
        : slugifyWorkspaceName(rawName);

    const createdWorkspace = await workspaceRepo.create({
      userId: authReq.pcpUserId,
      name: rawName,
      slug: workspaceSlug,
      type: workspaceType,
      description: workspaceDescription,
    });

    await workspaceRepo.addMember(createdWorkspace.id, authReq.pcpUserId, 'owner');

    res.status(201).json({
      workspace: {
        id: createdWorkspace.id,
        name: createdWorkspace.name,
        slug: createdWorkspace.slug,
        type: createdWorkspace.type,
        role: 'owner',
        description: createdWorkspace.description,
        metadata: createdWorkspace.metadata,
        createdAt: createdWorkspace.createdAt,
        updatedAt: createdWorkspace.updatedAt,
        archivedAt: createdWorkspace.archivedAt,
      },
    });
  } catch (error) {
    logger.error('Failed to create workspace container:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.toLowerCase().includes('duplicate')) {
      res.status(409).json({ error: 'A workspace with that slug already exists for this owner' });
      return;
    }
    res.status(500).json({ error: 'Failed to create workspace container' });
  }
});

/**
 * GET /api/admin/workspaces/:workspaceId/members
 * List collaborators for a workspace.
 */
router.get('/workspaces/:workspaceId/members', async (req: Request, res: Response) => {
  try {
    const authReq = req as AdminAuthRequest;
    const dataComposer = await getDataComposer();
    const workspaceRepo = dataComposer.repositories.workspaceContainers;
    const workspaceId = req.params.workspaceId;

    const workspace = await workspaceRepo.findById(workspaceId, authReq.pcpUserId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found or not accessible' });
      return;
    }

    const canManage = await workspaceRepo.canManageWorkspace(workspaceId, authReq.pcpUserId);
    const members = await workspaceRepo.listMembersWithUsers(workspaceId);

    res.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        type: workspace.type,
      },
      canManage,
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        user: member.user,
      })),
    });
  } catch (error) {
    logger.error('Failed to list workspace members:', error);
    res.status(500).json({ error: 'Failed to list workspace members' });
  }
});

/**
 * POST /api/admin/workspaces/:workspaceId/members
 * Invite/add collaborator by email to workspace.
 */
router.post('/workspaces/:workspaceId/members', async (req: Request, res: Response) => {
  try {
    const authReq = req as AdminAuthRequest;
    const dataComposer = await getDataComposer();
    const workspaceRepo = dataComposer.repositories.workspaceContainers;
    const usersRepo = dataComposer.repositories.users;
    const workspaceId = req.params.workspaceId;

    const workspace = await workspaceRepo.findById(workspaceId, authReq.pcpUserId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found or not accessible' });
      return;
    }

    const canManage = await workspaceRepo.canManageWorkspace(workspaceId, authReq.pcpUserId);
    if (!canManage) {
      res.status(403).json({ error: 'Only workspace owners/admins can invite collaborators' });
      return;
    }
    const actingRole = await workspaceRepo.getMemberRole(workspaceId, authReq.pcpUserId);

    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!rawEmail || !rawEmail.includes('@')) {
      res.status(400).json({ error: 'A valid email is required' });
      return;
    }

    const rawRole = typeof req.body?.role === 'string' ? req.body.role : 'member';
    const allowedRoles: WorkspaceMemberRole[] = ['owner', 'admin', 'member', 'viewer'];
    const memberRole: WorkspaceMemberRole = allowedRoles.includes(rawRole as WorkspaceMemberRole)
      ? (rawRole as WorkspaceMemberRole)
      : 'member';
    if (memberRole === 'owner' && actingRole !== 'owner') {
      res.status(403).json({ error: 'Only workspace owners can grant owner role' });
      return;
    }

    let inviteeUser = await usersRepo.findByEmail(rawEmail);
    let userWasCreated = false;

    if (!inviteeUser) {
      inviteeUser = await usersRepo.create({
        email: rawEmail,
      });
      userWasCreated = true;
      await workspaceRepo.ensurePersonalWorkspace(inviteeUser.id);
    }

    const membership = await workspaceRepo.addMember(workspaceId, inviteeUser.id, memberRole);

    res.status(201).json({
      member: {
        id: membership.id,
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role,
        createdAt: membership.createdAt,
        user: {
          id: inviteeUser.id,
          email: inviteeUser.email,
          firstName: inviteeUser.first_name,
          username: inviteeUser.username,
          lastLoginAt: inviteeUser.last_login_at,
        },
        userWasCreated,
      },
    });
  } catch (error) {
    logger.error('Failed to add workspace member:', error);
    res.status(500).json({ error: 'Failed to add workspace member' });
  }
});

// =============================================================================
// Trusted Users
// =============================================================================

/**
 * GET /api/admin/trusted-users
 * List all trusted users
 */
router.get('/trusted-users', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data: users, error } = await supabase
      .from('trusted_users')
      .select('*')
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('added_at', { ascending: false });

    if (error) {
      logger.error('Failed to list trusted users:', error);
      res.status(500).json({ error: 'Failed to list trusted users' });
      return;
    }

    res.json({
      users: (users || []).map((u) => ({
        id: u.id,
        platform: u.platform,
        platformUserId: u.platform_user_id,
        trustLevel: u.trust_level,
        addedAt: u.added_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to list trusted users:', error);
    res.status(500).json({ error: 'Failed to list trusted users' });
  }
});

/**
 * POST /api/admin/trusted-users
 * Add a new trusted user
 */
router.post('/trusted-users', async (req: Request, res: Response) => {
  try {
    const { platform, platformUserId, trustLevel } = req.body;
    const authReq = req as AdminAuthRequest;

    if (!platform || !platformUserId) {
      res.status(400).json({ error: 'platform and platformUserId are required' });
      return;
    }

    if (!['telegram', 'whatsapp', 'discord'].includes(platform)) {
      res.status(400).json({ error: 'platform must be telegram, whatsapp, or discord' });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { error } = await supabase.from('trusted_users').insert({
      user_id: null,
      platform,
      platform_user_id: platformUserId,
      trust_level: trustLevel || 'member',
      added_by: authReq.pcpUserId,
      workspace_id: authReq.pcpWorkspaceId,
    });

    if (error) {
      logger.error('Failed to add trusted user:', error);
      res.status(400).json({ error: error.message || 'Failed to add trusted user' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to add trusted user:', error);
    res.status(500).json({ error: 'Failed to add trusted user' });
  }
});

/**
 * DELETE /api/admin/trusted-users/:id
 * Remove a trusted user
 */
router.delete('/trusted-users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const authReq = req as AdminAuthRequest;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    // Don't allow deleting owners
    const { data: user } = await supabase
      .from('trusted_users')
      .select('trust_level')
      .eq('id', id)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .single();

    if (user?.trust_level === 'owner') {
      res.status(403).json({ error: 'Cannot remove owner' });
      return;
    }

    const { error } = await supabase
      .from('trusted_users')
      .delete()
      .eq('id', id)
      .eq('workspace_id', authReq.pcpWorkspaceId);

    if (error) {
      res.status(500).json({ error: 'Failed to delete user' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete trusted user:', error);
    res.status(500).json({ error: 'Failed to delete trusted user' });
  }
});

// =============================================================================
// Authorized Groups
// =============================================================================

/**
 * GET /api/admin/groups
 * List all authorized groups
 */
router.get('/groups', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data, error } = await supabase
      .from('authorized_groups')
      .select('*')
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('authorized_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to list groups' });
      return;
    }

    res.json({
      groups: (data || []).map((g) => ({
        id: g.id,
        platform: g.platform,
        platformGroupId: g.platform_group_id,
        groupName: g.group_name,
        authorizationMethod: g.authorization_method,
        authorizedAt: g.authorized_at,
        status: g.status,
      })),
    });
  } catch (error) {
    logger.error('Failed to list groups:', error);
    res.status(500).json({ error: 'Failed to list groups' });
  }
});

/**
 * POST /api/admin/groups/:id/revoke
 * Revoke a group authorization
 */
router.post('/groups/:id/revoke', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const authReq = req as AdminAuthRequest;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    const { error } = await supabase
      .from('authorized_groups')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: authReq.pcpUserId,
      })
      .eq('id', id)
      .eq('workspace_id', authReq.pcpWorkspaceId);

    if (error) {
      res.status(500).json({ error: 'Failed to revoke group' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to revoke group:', error);
    res.status(500).json({ error: 'Failed to revoke group' });
  }
});

// =============================================================================
// Challenge Codes
// =============================================================================

/**
 * GET /api/admin/challenge-codes
 * List all challenge codes
 */
router.get('/challenge-codes', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data, error } = await supabase
      .from('group_challenge_codes')
      .select('*')
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: 'Failed to list codes' });
      return;
    }

    res.json({
      codes: (data || []).map((c) => ({
        id: c.id,
        code: c.code,
        createdAt: c.created_at,
        expiresAt: c.expires_at,
        usedAt: c.used_at,
        usedForPlatform: c.used_for_platform,
        usedForGroupId: c.used_for_group_id,
      })),
    });
  } catch (error) {
    logger.error('Failed to list challenge codes:', error);
    res.status(500).json({ error: 'Failed to list codes' });
  }
});

/**
 * POST /api/admin/challenge-codes
 * Generate a new challenge code
 */
router.post('/challenge-codes', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    // Check rate limit
    const { count } = await supabase
      .from('group_challenge_codes')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString());

    if (count && count >= 5) {
      res.status(429).json({ error: 'Maximum 5 active codes allowed' });
      return;
    }

    // Generate code
    const code = Array.from(
      { length: 6 },
      () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]
    ).join('');

    const { data, error } = await supabase
      .from('group_challenge_codes')
      .insert({
        code,
        created_by: authReq.pcpUserId,
        workspace_id: authReq.pcpWorkspaceId,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to generate code' });
      return;
    }

    res.json({
      code: data.code,
      expiresAt: data.expires_at,
    });
  } catch (error) {
    logger.error('Failed to generate challenge code:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// =============================================================================
// WhatsApp
// =============================================================================

/**
 * GET /api/admin/whatsapp/status
 * Get WhatsApp connection status
 */
router.get('/whatsapp/status', async (_req: Request, res: Response) => {
  try {
    if (!whatsAppListener) {
      res.json({ connected: false, error: 'WhatsApp not configured' });
      return;
    }

    res.json({
      connected: whatsAppListener.connected,
      running: whatsAppListener.running,
    });
  } catch (error) {
    logger.error('Failed to get WhatsApp status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * GET /api/admin/whatsapp/qr
 * SSE endpoint for QR code streaming
 */
router.get('/whatsapp/qr', (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial status
  if (whatsAppListener?.connected) {
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
  }

  if (!whatsAppListener) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'WhatsApp not configured' })}\n\n`);
    return;
  }

  // Listen for QR codes
  const qrHandler = (qr: string) => {
    // Convert QR string to base64 data URL for display
    res.write(`data: ${JSON.stringify({ type: 'qr', qr })}\n\n`);
  };

  const connectedHandler = (info: { jid: string; e164: string | null }) => {
    res.write(
      `data: ${JSON.stringify({ type: 'connected', phoneNumber: info.e164 || info.jid })}\n\n`
    );
  };

  const disconnectedHandler = () => {
    res.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
  };

  whatsAppListener.on('qr', qrHandler);
  whatsAppListener.on('connected', connectedHandler);
  whatsAppListener.on('disconnected', disconnectedHandler);
  whatsAppListener.on('loggedOut', disconnectedHandler);

  // Clean up on close
  req.on('close', () => {
    whatsAppListener.off('qr', qrHandler);
    whatsAppListener.off('connected', connectedHandler);
    whatsAppListener.off('disconnected', disconnectedHandler);
    whatsAppListener.off('loggedOut', disconnectedHandler);
  });
});

/**
 * POST /api/admin/whatsapp/logout
 * Logout from WhatsApp
 */
router.post('/whatsapp/logout', async (_req: Request, res: Response) => {
  try {
    if (!whatsAppListener) {
      res.status(400).json({ error: 'WhatsApp not configured' });
      return;
    }

    await whatsAppListener.stop();
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to logout WhatsApp:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// =============================================================================
// Heartbeat / Scheduled Tasks
// =============================================================================

/**
 * POST /api/admin/heartbeat
 * Process heartbeat - check for due reminders and execute them
 * Called by pg_cron in production or node-cron locally
 */
router.post('/heartbeat', async (_req: Request, res: Response) => {
  try {
    // Import dynamically to avoid circular dependencies
    const { processHeartbeat } = await import('../services/heartbeat.js');
    const stats = await processHeartbeat();

    res.json({
      success: true,
      ...stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Heartbeat processing failed:', error);
    res.status(500).json({ error: 'Heartbeat processing failed' });
  }
});

/**
 * GET /api/admin/reminders
 * List reminders for the active user + workspace (admin view)
 */
router.get('/reminders', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data, error } = await supabase
      .from('scheduled_reminders')
      .select('*, users(email, first_name)')
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('next_run_at', { ascending: true })
      .limit(100);

    if (error) {
      res.status(500).json({ error: 'Failed to list reminders' });
      return;
    }

    res.json({
      reminders: (data || []).map((r) => ({
        id: r.id,
        userId: r.user_id,
        title: r.title,
        description: r.description,
        cronExpression: r.cron_expression,
        nextRunAt: r.next_run_at,
        lastRunAt: r.last_run_at,
        deliveryChannel: r.delivery_channel,
        status: r.status,
        runCount: r.run_count,
      })),
    });
  } catch (error) {
    logger.error('Failed to list reminders:', error);
    res.status(500).json({ error: 'Failed to list reminders' });
  }
});

// =============================================================================
// User Identity (USER.md, VALUES.md)
// =============================================================================

/**
 * GET /api/admin/user-identity
 * Get user identity (USER.md, VALUES.md)
 */
router.get('/user-identity', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data, error } = await supabase
      .from('user_identity')
      .select('*')
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Failed to get user identity:', error);
      res.status(500).json({ error: 'Failed to get user identity' });
      return;
    }

    if (!data) {
      res.json({ userIdentity: null });
      return;
    }

    res.json({
      userIdentity: {
        id: data.id,
        userId: data.user_id,
        userProfileMd: data.user_profile_md,
        sharedValuesMd: data.shared_values_md,
        version: data.version,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      },
    });
  } catch (error) {
    logger.error('Failed to get user identity:', error);
    res.status(500).json({ error: 'Failed to get user identity' });
  }
});

/**
 * GET /api/admin/user-identity/history
 * Get version history for user identity
 */
router.get('/user-identity/history', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    // First get the user identity ID
    const { data: identity } = await supabase
      .from('user_identity')
      .select('id')
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .single();

    if (!identity) {
      res.json({ history: [] });
      return;
    }

    // Get history entries
    const { data, error } = await supabase
      .from('user_identity_history')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('archived_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.error('Failed to get user identity history:', error);
      res.status(500).json({ error: 'Failed to get history' });
      return;
    }

    res.json({
      history: (data || []).map((h) => ({
        id: h.id,
        version: h.version,
        userProfileMd: h.user_profile_md,
        sharedValuesMd: h.shared_values_md,
        changeType: h.change_type,
        createdAt: h.created_at,
        archivedAt: h.archived_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to get user identity history:', error);
    res.status(500).json({ error: 'Failed to get user identity history' });
  }
});

// =============================================================================
// Individuals (AI Beings)
// =============================================================================

/**
 * GET /api/admin/individuals
 * List all AI being identities
 */
router.get('/individuals', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data, error } = await supabase
      .from('agent_identities')
      .select('*')
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('agent_id', { ascending: true });

    if (error) {
      logger.error('Failed to list individuals:', error);
      res.status(500).json({ error: 'Failed to list individuals' });
      return;
    }

    res.json({
      individuals: (data || []).map((identity) => ({
        id: identity.id,
        agentId: identity.agent_id,
        name: identity.name,
        role: identity.role,
        description: identity.description,
        values: identity.values,
        relationships: identity.relationships,
        capabilities: identity.capabilities,
        metadata: identity.metadata,
        heartbeat: identity.heartbeat,
        soul: identity.soul,
        hasSoul: !!identity.soul,
        hasHeartbeat: !!identity.heartbeat,
        version: identity.version,
        createdAt: identity.created_at,
        updatedAt: identity.updated_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to list individuals:', error);
    res.status(500).json({ error: 'Failed to list individuals' });
  }
});

/**
 * GET /api/admin/individuals/:agentId/history
 * Get version history for an AI being
 */
router.get('/individuals/:agentId/history', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    // First get the identity ID
    const { data: identity } = await supabase
      .from('agent_identities')
      .select('id')
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .eq('agent_id', agentId)
      .single();

    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    // Get history entries
    const { data, error } = await supabase
      .from('agent_identity_history')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('archived_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.error('Failed to get identity history:', error);
      res.status(500).json({ error: 'Failed to get history' });
      return;
    }

    res.json({
      agentId,
      history: (data || []).map((h) => ({
        id: h.id,
        version: h.version,
        name: h.name,
        role: h.role,
        description: h.description,
        values: h.values,
        relationships: h.relationships,
        capabilities: h.capabilities,
        heartbeat: h.heartbeat,
        soul: h.soul,
        hasSoul: !!h.soul,
        hasHeartbeat: !!h.heartbeat,
        changeType: h.change_type,
        archivedAt: h.archived_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to get identity history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// =============================================================================
// Memory Timeline
// =============================================================================

interface TimelineEntry {
  id: string;
  type: 'memory_created' | 'memory_updated' | 'memory_deleted' | 'log_compacted' | 'log_discarded';
  timestamp: string;
  content: string;
  salience: string;
  source?: string;
  topics?: string[];
  metadata?: Record<string, unknown>;
  version?: number;
  memoryId?: string;
  sessionId?: string;
  changeType?: string;
}

/**
 * GET /api/admin/individuals/:agentId/memories/timeline
 * Get full memory activity timeline for an AI being
 */
router.get('/individuals/:agentId/memories/timeline', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const authReq = req as AdminAuthRequest;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const timeline: TimelineEntry[] = [];

    // 1. Get current memories (created events)
    const { data: memories, error: memoriesError } = await supabase
      .from('memories')
      .select('*')
      .eq('user_id', authReq.pcpUserId)
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false });

    if (memoriesError) {
      logger.error('Failed to fetch memories:', memoriesError);
    } else if (memories) {
      for (const m of memories) {
        timeline.push({
          id: `memory-created-${m.id}`,
          type: 'memory_created',
          timestamp: m.created_at,
          content: m.content,
          salience: m.salience,
          source: m.source,
          topics: m.topics,
          metadata: m.metadata as Record<string, unknown>,
          version: m.version,
          memoryId: m.id,
        });
      }
    }

    // 2. Get memory history (update and delete events)
    // We need to filter by agent_id through the memories table or check metadata
    const { data: history, error: historyError } = await supabase
      .from('memory_history')
      .select('*')
      .eq('user_id', authReq.pcpUserId)
      .order('archived_at', { ascending: false });

    if (historyError) {
      logger.error('Failed to fetch memory history:', historyError);
    } else if (history) {
      // Filter history entries that belong to this agent's memories
      const agentMemoryIds = new Set(memories?.map((m) => m.id) || []);

      for (const h of history) {
        // Include if it's a deleted memory that belonged to this agent
        // or if it's an update to an existing agent memory
        const isAgentMemory = agentMemoryIds.has(h.memory_id);
        const hasAgentMetadata = (h.metadata as Record<string, unknown>)?.agentId === agentId;

        if (isAgentMemory || hasAgentMetadata) {
          timeline.push({
            id: `memory-${h.change_type}-${h.id}`,
            type: h.change_type === 'delete' ? 'memory_deleted' : 'memory_updated',
            timestamp: h.archived_at,
            content: h.content,
            salience: h.salience,
            source: h.source,
            topics: h.topics,
            metadata: h.metadata as Record<string, unknown>,
            version: h.version,
            memoryId: h.memory_id,
            changeType: h.change_type,
          });
        }
      }
    }

    // 3. Get compacted session logs (through sessions with matching agent_id)
    const { data: sessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('id')
      .eq('user_id', authReq.pcpUserId)
      .eq('agent_id', agentId);

    if (sessionsError) {
      logger.error('Failed to fetch sessions:', sessionsError);
    } else if (sessions && sessions.length > 0) {
      const sessionIds = sessions.map((s) => s.id);

      const { data: logs, error: logsError } = await supabase
        .from('session_logs')
        .select('*')
        .in('session_id', sessionIds)
        .not('compacted_at', 'is', null)
        .order('compacted_at', { ascending: false });

      if (logsError) {
        logger.error('Failed to fetch session logs:', logsError);
      } else if (logs) {
        for (const log of logs) {
          timeline.push({
            id: `log-compacted-${log.id}`,
            type: log.compacted_into_memory_id ? 'log_compacted' : 'log_discarded',
            timestamp: log.compacted_at!,
            content: log.content,
            salience: log.salience,
            sessionId: log.session_id,
            memoryId: log.compacted_into_memory_id || undefined,
          });
        }
      }
    }

    // Sort by timestamp descending
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply pagination
    const paginatedTimeline = timeline.slice(offset, offset + limit);

    res.json({
      agentId,
      timeline: paginatedTimeline,
      total: timeline.length,
      limit,
      offset,
    });
  } catch (error) {
    logger.error('Failed to get memory timeline:', error);
    res.status(500).json({ error: 'Failed to get memory timeline' });
  }
});

/**
 * GET /api/admin/individuals/:agentId/memories/:memoryId/history
 * Get version history for a specific memory
 */
router.get(
  '/individuals/:agentId/memories/:memoryId/history',
  async (req: Request, res: Response) => {
    try {
      const { memoryId } = req.params;
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
      const authReq = req as AdminAuthRequest;

      // Get memory history
      const { data, error } = await supabase
        .from('memory_history')
        .select('*')
        .eq('user_id', authReq.pcpUserId)
        .eq('memory_id', memoryId)
        .order('version', { ascending: false });

      if (error) {
        logger.error('Failed to get memory history:', error);
        res.status(500).json({ error: 'Failed to get memory history' });
        return;
      }

      res.json({
        memoryId,
        history: (data || []).map((h) => ({
          id: h.id,
          version: h.version,
          content: h.content,
          salience: h.salience,
          source: h.source,
          topics: h.topics,
          metadata: h.metadata,
          changeType: h.change_type,
          createdAt: h.created_at,
          archivedAt: h.archived_at,
        })),
      });
    } catch (error) {
      logger.error('Failed to get memory history:', error);
      res.status(500).json({ error: 'Failed to get memory history' });
    }
  }
);

// =============================================================================
// Connected Accounts (OAuth)
// =============================================================================

// In-memory store for OAuth state (in production, use Redis or similar)
const oauthStateStore = new Map<
  string,
  {
    userId: string;
    workspaceId: string;
    provider: string;
    expiresAt: number;
  }
>();

/**
 * GET /api/admin/connected-accounts
 * List all connected accounts for the authenticated user
 */
router.get('/connected-accounts', async (req: Request, res: Response) => {
  try {
    const authReq = req as AdminAuthRequest;

    const oauthService = getOAuthService();
    const accounts = await oauthService.getConnectedAccounts(
      authReq.pcpUserId,
      authReq.pcpWorkspaceId
    );

    // Get supported providers and their configuration status
    const providers = oauthService.getSupportedProviders().map((provider) => ({
      name: provider,
      configured: oauthService.isProviderConfigured(provider),
      connected: accounts.some((a) => a.provider === provider && a.status === 'active'),
    }));

    res.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        email: a.email,
        displayName: a.displayName,
        avatarUrl: a.avatarUrl,
        status: a.status,
        lastError: a.lastError,
        lastUsedAt: a.lastUsedAt,
        expiresAt: a.expiresAt,
        scopes: a.scopes,
        createdAt: a.createdAt,
      })),
      providers,
    });
  } catch (error) {
    logger.error('Failed to list connected accounts:', error);
    res.status(500).json({ error: 'Failed to list connected accounts' });
  }
});

/**
 * GET /api/admin/oauth/:provider/authorize
 * Start OAuth flow for a provider
 */
router.get('/oauth/:provider/authorize', async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const oauthService = getOAuthService();
    const authReq = req as AdminAuthRequest;

    if (!oauthService.isProviderConfigured(provider)) {
      res.status(400).json({ error: `OAuth not configured for ${provider}` });
      return;
    }

    // Generate state token
    const state = crypto.randomBytes(32).toString('hex');

    // Store state with user info (expires in 10 minutes)
    oauthStateStore.set(state, {
      userId: authReq.pcpUserId,
      workspaceId: authReq.pcpWorkspaceId,
      provider,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    // Build redirect URI
    // OAUTH_REDIRECT_BASE_URL can be either:
    // - Just the origin (e.g., http://localhost:3001) - path will be appended
    // - Full redirect URI (e.g., http://localhost:3001/api/admin/oauth/google/callback) - used as-is
    const configuredUrl = env.OAUTH_REDIRECT_BASE_URL;
    const defaultPath = `/api/admin/oauth/${provider}/callback`;
    let redirectUri: string;
    if (configuredUrl) {
      // If the configured URL has a path (not just origin), use it as-is
      const url = new URL(configuredUrl);
      redirectUri = url.pathname !== '/' ? configuredUrl : `${configuredUrl}${defaultPath}`;
    } else {
      redirectUri = `http://localhost:${env.MCP_HTTP_PORT}${defaultPath}`;
    }

    const authUrl = oauthService.getAuthorizationUrl(provider, redirectUri, state);

    res.json({ authUrl });
  } catch (error) {
    logger.error('Failed to start OAuth flow:', error);
    res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
});

/**
 * GET /api/admin/oauth/:provider/callback
 * OAuth callback handler (no auth required - uses state token)
 */
router.get('/oauth/:provider/callback', async (req: Request, res: Response) => {
  // Remove auth middleware for this route by handling it specially
  const { provider } = req.params;
  const { code, state, error: oauthError } = req.query;

  // HTML response helper
  const sendHtmlResponse = (success: boolean, message: string) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>${success ? 'Connected' : 'Error'}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
    p { color: #666; margin: 1rem 0; }
    button { background: #3b82f6; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; cursor: pointer; font-size: 1rem; }
    button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="${success ? 'success' : 'error'}">${success ? 'Account Connected!' : 'Connection Failed'}</h1>
    <p>${message}</p>
    <button onclick="window.close()">Close Window</button>
    <script>
      // Notify parent window and close
      if (window.opener) {
        window.opener.postMessage({ type: 'oauth-callback', success: ${success}, provider: '${provider}' }, '*');
      }
    </script>
  </div>
</body>
</html>`;
    res.send(html);
  };

  try {
    if (oauthError) {
      sendHtmlResponse(false, `OAuth error: ${oauthError}`);
      return;
    }

    if (!code || !state) {
      sendHtmlResponse(false, 'Missing code or state parameter');
      return;
    }

    // Validate state
    const stateData = oauthStateStore.get(state as string);
    if (!stateData) {
      sendHtmlResponse(false, 'Invalid or expired state token');
      return;
    }

    // Check expiry
    if (Date.now() > stateData.expiresAt) {
      oauthStateStore.delete(state as string);
      sendHtmlResponse(false, 'OAuth session expired. Please try again.');
      return;
    }

    // Clean up state
    oauthStateStore.delete(state as string);

    // Exchange code for tokens (redirect URI must match what was sent in auth request)
    const oauthService = getOAuthService();
    const configuredUrl = env.OAUTH_REDIRECT_BASE_URL;
    const defaultPath = `/api/admin/oauth/${provider}/callback`;
    let redirectUri: string;
    if (configuredUrl) {
      const url = new URL(configuredUrl);
      redirectUri = url.pathname !== '/' ? configuredUrl : `${configuredUrl}${defaultPath}`;
    } else {
      redirectUri = `http://localhost:${env.MCP_HTTP_PORT}${defaultPath}`;
    }

    const tokens = await oauthService.exchangeCode(provider, code as string, redirectUri);

    // Get user info
    const userInfo = await oauthService.getUserInfo(provider, tokens.accessToken);

    // Save connected account
    await oauthService.saveConnectedAccount(
      stateData.userId,
      provider,
      tokens,
      userInfo,
      stateData.workspaceId
    );

    sendHtmlResponse(true, `Successfully connected ${userInfo.email || provider} account.`);
  } catch (error) {
    logger.error('OAuth callback error:', error);
    sendHtmlResponse(false, error instanceof Error ? error.message : 'Failed to connect account');
  }
});

/**
 * GET /api/admin/oauth/:provider/required-scopes
 * Get the required scopes for a provider to check if upgrade is needed
 */
router.get('/oauth/:provider/required-scopes', async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const oauthService = getOAuthService();

    if (!oauthService.isProviderConfigured(provider)) {
      res.status(400).json({ error: `OAuth not configured for ${provider}` });
      return;
    }

    const requiredScopes = oauthService.getRequiredScopes(provider);
    res.json({ provider, requiredScopes });
  } catch (error) {
    logger.error('Failed to get required scopes:', error);
    res.status(500).json({ error: 'Failed to get required scopes' });
  }
});

/**
 * POST /api/admin/oauth/:provider/upgrade-scopes
 * Start OAuth flow to upgrade scopes for an existing connection
 */
router.post('/oauth/:provider/upgrade-scopes', async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const { accountId } = req.body;
    const oauthService = getOAuthService();
    const authReq = req as AdminAuthRequest;

    if (!oauthService.isProviderConfigured(provider)) {
      res.status(400).json({ error: `OAuth not configured for ${provider}` });
      return;
    }

    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    // Get the connected account
    const { data: account, error: accountError } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .single();

    if (accountError || !account) {
      res.status(404).json({ error: 'Connected account not found' });
      return;
    }

    const currentScopes = (account.scopes as string[]) || [];
    const missingScopes = oauthService.getMissingScopes(provider, currentScopes);

    if (missingScopes.length === 0) {
      res.json({
        needsUpgrade: false,
        message: 'All required scopes are already granted',
      });
      return;
    }

    // Generate state token
    const state = crypto.randomUUID();
    oauthStateStore.set(state, {
      userId: authReq.pcpUserId,
      workspaceId: authReq.pcpWorkspaceId,
      provider,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    // Build redirect URI
    const configuredUrl = env.OAUTH_REDIRECT_BASE_URL;
    const defaultPath = `/api/admin/oauth/${provider}/callback`;
    let redirectUri: string;
    if (configuredUrl) {
      const url = new URL(configuredUrl);
      redirectUri = url.pathname !== '/' ? configuredUrl : `${configuredUrl}${defaultPath}`;
    } else {
      redirectUri = `http://localhost:${env.MCP_HTTP_PORT}${defaultPath}`;
    }

    // Get upgrade URL with login hint
    const authUrl = oauthService.getUpgradeScopesUrl(
      provider,
      redirectUri,
      state,
      currentScopes,
      account.email as string | undefined
    );

    res.json({
      needsUpgrade: true,
      authUrl,
      missingScopes,
      currentScopes,
    });
  } catch (error) {
    logger.error('Failed to start scope upgrade:', error);
    res.status(500).json({ error: 'Failed to start scope upgrade' });
  }
});

// =============================================================================
// Artifacts
// =============================================================================

/**
 * GET /api/admin/artifacts
 * List all artifacts
 */
router.get('/artifacts', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data, error } = await supabase
      .from('artifacts')
      .select('id, uri, title, artifact_type, visibility, version, tags, created_at, updated_at')
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('updated_at', { ascending: false });

    if (error) {
      logger.error('Failed to list artifacts:', error);
      res.status(500).json({ error: 'Failed to list artifacts' });
      return;
    }

    res.json({
      artifacts: (data || []).map((a) => ({
        id: a.id,
        uri: a.uri,
        title: a.title,
        artifactType: a.artifact_type,
        visibility: a.visibility,
        version: a.version,
        tags: a.tags,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to list artifacts:', error);
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});

/**
 * GET /api/admin/artifacts/:id
 * Get a single artifact with full content
 */
router.get('/artifacts/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const { data: artifact, error } = await supabase
      .from('artifacts')
      .select('*')
      .eq('id', id)
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .single();

    if (error || !artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    res.json({
      artifact: {
        id: artifact.id,
        uri: artifact.uri,
        title: artifact.title,
        content: artifact.content,
        contentType: artifact.content_type,
        artifactType: artifact.artifact_type,
        createdByIdentityId: artifact.created_by_identity_id,
        collaborators: artifact.collaborators,
        visibility: artifact.visibility,
        version: artifact.version,
        tags: artifact.tags,
        metadata: artifact.metadata,
        createdAt: artifact.created_at,
        updatedAt: artifact.updated_at,
      },
    });
  } catch (error) {
    logger.error('Failed to get artifact:', error);
    res.status(500).json({ error: 'Failed to get artifact' });
  }
});

/**
 * GET /api/admin/artifacts/:id/comments
 * List comments for a specific artifact
 */
router.get('/artifacts/:id/comments', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;
    const pcpUserId = authReq.pcpUserId;
    const workspaceId = authReq.pcpWorkspaceId;

    const { data: artifact } = await supabase
      .from('artifacts')
      .select('id')
      .eq('id', id)
      .eq('user_id', pcpUserId)
      .eq('workspace_id', workspaceId)
      .single();

    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    const { data: comments, error } = await supabase
      .from('artifact_comments')
      .select('*')
      .eq('artifact_id', id)
      .eq('user_id', pcpUserId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Failed to list artifact comments:', error);
      res.status(500).json({ error: 'Failed to list comments' });
      return;
    }

    const identityIds = Array.from(
      new Set((comments || []).map((c) => c.created_by_identity_id).filter(Boolean) as string[])
    );
    const commentAuthorUserIds = Array.from(
      new Set(
        (comments || [])
          .map((c) => c.created_by_user_id || c.user_id)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
      )
    );

    const identitiesById = new Map<
      string,
      { id: string; agent_id: string; name: string; backend: string | null }
    >();
    const commentUsersById = new Map<string, CommentAuthorUser>();

    if (identityIds.length > 0) {
      const { data: identities, error: identitiesError } = await supabase
        .from('agent_identities')
        .select('id, agent_id, name, backend')
        .in('id', identityIds);

      if (identitiesError) {
        logger.error('Failed to resolve artifact comment identities:', identitiesError);
        res.status(500).json({ error: 'Failed to resolve comment identities' });
        return;
      }

      for (const identity of identities || []) {
        identitiesById.set(identity.id, identity);
      }
    }

    if (commentAuthorUserIds.length > 0) {
      const { data: commentUsers, error: commentUsersError } = await supabase
        .from('users')
        .select('id, first_name, username, email')
        .in('id', commentAuthorUserIds);

      if (commentUsersError) {
        logger.error('Failed to resolve artifact comment users:', commentUsersError);
        res.status(500).json({ error: 'Failed to resolve comment users' });
        return;
      }

      for (const commentUser of commentUsers || []) {
        commentUsersById.set(commentUser.id, commentUser);
      }
    }

    res.json({
      artifactId: id,
      comments: (comments || []).map((comment) => {
        const identity = comment.created_by_identity_id
          ? (identitiesById.get(comment.created_by_identity_id) ?? null)
          : null;
        const commentAuthorUserId = comment.created_by_user_id || comment.user_id || null;
        const commentAuthorUser = commentAuthorUserId
          ? (commentUsersById.get(commentAuthorUserId) ?? null)
          : null;
        return {
          id: comment.id,
          artifactId: comment.artifact_id,
          parentCommentId: comment.parent_comment_id,
          content: comment.content,
          metadata: comment.metadata,
          createdByAgentId: identity?.agent_id ?? null,
          createdByUserId: commentAuthorUserId,
          createdByUser: commentAuthorUser
            ? {
                id: commentAuthorUser.id,
                name: formatCommentAuthorUserName(commentAuthorUser),
                username: commentAuthorUser.username,
                email: commentAuthorUser.email,
              }
            : null,
          createdByIdentityId: comment.created_by_identity_id,
          createdByIdentity: identity
            ? {
                id: identity.id,
                agentId: identity.agent_id,
                name: identity.name,
                backend: identity.backend,
              }
            : null,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        };
      }),
    });
  } catch (error) {
    logger.error('Failed to list artifact comments:', error);
    res.status(500).json({ error: 'Failed to list comments' });
  }
});

/**
 * POST /api/admin/artifacts/:id/comments
 * Add a comment to a specific artifact
 */
router.post('/artifacts/:id/comments', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { content, agentId, parentCommentId, metadata } = req.body as {
      content?: string;
      agentId?: string;
      parentCommentId?: string;
      metadata?: Record<string, unknown>;
    };
    const trimmed = content?.trim() || '';

    if (!trimmed) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;
    const pcpUserId = authReq.pcpUserId;
    const workspaceId = authReq.pcpWorkspaceId;

    const { data: artifact } = await supabase
      .from('artifacts')
      .select('id')
      .eq('id', id)
      .eq('user_id', pcpUserId)
      .eq('workspace_id', workspaceId)
      .single();

    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    if (parentCommentId) {
      const { data: parent } = await supabase
        .from('artifact_comments')
        .select('id')
        .eq('id', parentCommentId)
        .eq('artifact_id', id)
        .eq('user_id', pcpUserId)
        .eq('workspace_id', workspaceId)
        .single();

      if (!parent) {
        res.status(400).json({ error: 'Invalid parentCommentId' });
        return;
      }
    }

    let identity: { id: string; agent_id: string; name: string; backend: string | null } | null =
      null;
    if (agentId) {
      const { data: identityRow, error: identityError } = await supabase
        .from('agent_identities')
        .select('id, agent_id, name, backend')
        .eq('user_id', pcpUserId)
        .eq('workspace_id', workspaceId)
        .eq('agent_id', agentId)
        .single();

      if (identityError || !identityRow) {
        // Deliberately stricter than MCP tool behavior:
        // dashboard/admin writes should reference a known identity explicitly,
        // while MCP handlers allow slug-only fallback for backward compatibility.
        res.status(400).json({ error: `Unknown agent identity: ${agentId}` });
        return;
      }
      identity = identityRow;
    }

    const { data: comment, error } = await supabase
      .from('artifact_comments')
      .insert({
        artifact_id: id,
        user_id: pcpUserId,
        created_by_user_id: pcpUserId,
        workspace_id: workspaceId,
        created_by_identity_id: identity?.id || null,
        parent_comment_id: parentCommentId || null,
        content: trimmed,
        metadata: metadata || {},
      })
      .select('*')
      .single();

    if (error || !comment) {
      logger.error('Failed to create artifact comment:', error);
      res.status(500).json({ error: 'Failed to create comment' });
      return;
    }

    const { data: commentAuthorUser } = await supabase
      .from('users')
      .select('id, first_name, username, email')
      .eq('id', pcpUserId)
      .maybeSingle();

    res.json({
      comment: {
        id: comment.id,
        artifactId: comment.artifact_id,
        parentCommentId: comment.parent_comment_id,
        content: comment.content,
        metadata: comment.metadata,
        createdByAgentId: identity?.agent_id ?? null,
        createdByUserId: comment.created_by_user_id || pcpUserId,
        createdByUser: commentAuthorUser
          ? {
              id: commentAuthorUser.id,
              name: formatCommentAuthorUserName(commentAuthorUser),
              username: commentAuthorUser.username,
              email: commentAuthorUser.email,
            }
          : null,
        createdByIdentityId: comment.created_by_identity_id,
        createdByIdentity: identity
          ? {
              id: identity.id,
              agentId: identity.agent_id,
              name: identity.name,
              backend: identity.backend,
            }
          : null,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      },
    });
  } catch (error) {
    logger.error('Failed to create artifact comment:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

/**
 * GET /api/admin/artifacts/:id/history
 * Get version history for an artifact
 */
router.get('/artifacts/:id/history', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    // Verify artifact ownership
    const { data: artifact } = await supabase
      .from('artifacts')
      .select('id')
      .eq('id', id)
      .eq('user_id', authReq.pcpUserId)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .single();

    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    // Get history
    const { data: history, error } = await supabase
      .from('artifact_history')
      .select('*')
      .eq('artifact_id', id)
      .eq('workspace_id', authReq.pcpWorkspaceId)
      .order('version', { ascending: false });

    if (error) {
      logger.error('Failed to get artifact history:', error);
      res.status(500).json({ error: 'Failed to get history' });
      return;
    }

    res.json({
      artifactId: id,
      history: (history || []).map((h) => ({
        id: h.id,
        version: h.version,
        title: h.title,
        content: h.content,
        changedByIdentityId: h.changed_by_identity_id,
        changedByUserId: h.changed_by_user_id,
        changeType: h.change_type,
        changeSummary: h.change_summary,
        createdAt: h.created_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to get artifact history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// =============================================================================
// Connected Accounts (OAuth)
// =============================================================================

/**
 * DELETE /api/admin/connected-accounts/:id
 * Disconnect an account
 */
router.delete('/connected-accounts/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const authReq = req as AdminAuthRequest;

    const oauthService = getOAuthService();
    await oauthService.disconnectAccount(id, authReq.pcpUserId, authReq.pcpWorkspaceId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to disconnect account:', error);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

// =============================================================================
// Sessions & Studios
// =============================================================================

/**
 * GET /api/admin/sessions
 * List sessions with linked agent identities and workspaces (studios)
 */
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const authReq = req as AdminAuthRequest;
    const includeCompleted = req.query.includeCompleted === 'true';

    // 1. Fetch sessions for the user
    let sessionsQuery = supabase
      .from('sessions')
      .select('*')
      .eq('user_id', authReq.pcpUserId)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (!includeCompleted) {
      sessionsQuery = sessionsQuery.in('status', ['active', 'paused']);
    }

    const { data: sessions, error: sessionsError } = await sessionsQuery;

    if (sessionsError) {
      logger.error('Failed to list sessions:', sessionsError);
      res.status(500).json({ error: 'Failed to list sessions' });
      return;
    }

    const sessionRows = sessions || [];

    // 2. Batch-fetch agent identities for unique agent_ids
    const uniqueAgentIds = [...new Set(sessionRows.map((s) => s.agent_id).filter(Boolean))];
    const identitiesByAgentId = new Map<string, { name: string; role: string | null }>();

    if (uniqueAgentIds.length > 0) {
      // Look up identities by user_id (not workspace container) so names resolve
      // for sessions across all containers. agent_id is typically unique per user.
      const { data: identities } = await supabase
        .from('agent_identities')
        .select('agent_id, name, role')
        .eq('user_id', authReq.pcpUserId)
        .in('agent_id', uniqueAgentIds);

      for (const identity of identities || []) {
        identitiesByAgentId.set(identity.agent_id, {
          name: identity.name,
          role: identity.role,
        });
      }
    }

    // 3. Batch-fetch studios linked to these sessions (studio_id preferred, session_id fallback)
    const sessionIds = sessionRows.map((s) => s.id);
    const studioIds = [
      ...new Set(sessionRows.map((s) => s.studio_id || s.workspace_id).filter(Boolean)),
    ] as string[];

    const studiosById = new Map<
      string,
      {
        id: string;
        branch: string | null;
        baseBranch: string | null;
        purpose: string | null;
        workType: string | null;
        status: string;
      }
    >();
    const workspacesBySessionId = new Map<
      string,
      {
        id: string;
        branch: string | null;
        baseBranch: string | null;
        purpose: string | null;
        workType: string | null;
        status: string;
      }
    >();

    if (studioIds.length > 0) {
      const { data: studios } = await supabase
        .from('studios')
        .select('id, branch, base_branch, purpose, work_type, status')
        .in('id', studioIds);

      for (const studio of studios || []) {
        studiosById.set(studio.id, {
          id: studio.id,
          branch: studio.branch,
          baseBranch: studio.base_branch,
          purpose: studio.purpose,
          workType: studio.work_type,
          status: studio.status,
        });
      }
    }

    // Fallback: support older rows linked only by workspaces.session_id.
    if (sessionIds.length > 0) {
      const { data: linkedWorkspaces } = await supabase
        .from('studios')
        .select('id, session_id, branch, base_branch, purpose, work_type, status')
        .in('session_id', sessionIds);

      for (const ws of linkedWorkspaces || []) {
        if (ws.session_id) {
          workspacesBySessionId.set(ws.session_id, {
            id: ws.id,
            branch: ws.branch,
            baseBranch: ws.base_branch,
            purpose: ws.purpose,
            workType: ws.work_type,
            status: ws.status,
          });
        }
      }
    }

    // 4. Build a small preview feed per session (cloud logs first).
    const previewsBySessionId = new Map<string, SessionPreviewItem[]>();
    if (sessionIds.length > 0) {
      const [{ data: activityRows }, { data: sessionLogRows }] = await Promise.all([
        supabase
          .from('activity_stream')
          .select('id, session_id, type, subtype, content, created_at, payload')
          .eq('user_id', authReq.pcpUserId)
          .in('session_id', sessionIds)
          .order('created_at', { ascending: false })
          .limit(Math.min(2000, Math.max(300, sessionIds.length * 8))),
        supabase
          .from('session_logs')
          .select('id, session_id, content, salience, created_at')
          .in('session_id', sessionIds)
          .order('created_at', { ascending: false })
          .limit(Math.min(1000, Math.max(200, sessionIds.length * 4))),
      ]);

      const mergedBySession = new Map<string, SessionLogItem[]>();
      for (const row of activityRows || []) {
        if (!row.session_id) continue;
        const list = mergedBySession.get(row.session_id) || [];
        list.push(
          toActivityLogItem({
            id: row.id,
            type: row.type,
            subtype: row.subtype,
            content: row.content,
            created_at: row.created_at,
            payload: row.payload,
          })
        );
        mergedBySession.set(row.session_id, list);
      }
      for (const row of sessionLogRows || []) {
        const list = mergedBySession.get(row.session_id) || [];
        list.push(
          toSessionLogItem({
            id: row.id,
            content: row.content,
            salience: row.salience,
            created_at: row.created_at,
          })
        );
        mergedBySession.set(row.session_id, list);
      }

      for (const [sessionId, items] of mergedBySession.entries()) {
        const preview = [...items]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, ACTIVITY_PREVIEW_LIMIT_PER_SESSION)
          .map((item) => ({
            id: item.id,
            source: item.source,
            type: item.type,
            role: item.role,
            content: item.content,
            timestamp: item.timestamp,
          }));
        previewsBySessionId.set(sessionId, preview);
      }
    }

    // 5. Compute stats
    const stats = {
      active: sessionRows.filter(
        (s) => s.status === 'active' && !s.current_phase?.startsWith('blocked')
      ).length,
      blocked: sessionRows.filter((s) => s.current_phase?.startsWith('blocked')).length,
      paused: sessionRows.filter((s) => s.status === 'paused').length,
      total: sessionRows.length,
    };

    res.json({
      stats,
      sessions: sessionRows.map((s) => {
        const identity = s.agent_id ? identitiesByAgentId.get(s.agent_id) : null;
        return {
          id: s.id,
          backendSessionId: s.claude_session_id || null,
          agentId: s.agent_id,
          agentName: identity?.name || s.agent_id || 'Unknown',
          agentRole: identity?.role || null,
          status: s.status,
          currentPhase: s.current_phase,
          summary: s.summary,
          context: s.context,
          backend: s.backend,
          model: s.model,
          messageCount: s.message_count,
          tokenCount: s.token_count,
          startedAt: s.started_at,
          updatedAt: s.updated_at,
          endedAt: s.ended_at,
          preview: previewsBySessionId.get(s.id) || [],
          workspace: workspacesBySessionId.get(s.id) || null,
          studio:
            studiosById.get(s.studio_id || s.workspace_id || '') || workspacesBySessionId.get(s.id) || null,
        };
      }),
    });
  } catch (error) {
    logger.error('Failed to list sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/admin/sessions/:id/logs
 * Get merged session logs (activity stream + session_logs + optional local transcript fallback)
 */
router.get('/sessions/:id/logs', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const authReq = req as AdminAuthRequest;
    const limit = Math.min(
      MAX_SESSION_LOG_LIMIT,
      Math.max(1, Number.parseInt(String(req.query.limit || DEFAULT_SESSION_LOG_LIMIT), 10) || DEFAULT_SESSION_LOG_LIMIT)
    );
    const offset = Math.max(0, Number.parseInt(String(req.query.offset || 0), 10) || 0);
    const includeLocal = req.query.includeLocal !== 'false';

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, agent_id, status, current_phase, started_at, updated_at, ended_at, backend, backend_session_id, claude_session_id')
      .eq('id', sessionId)
      .eq('user_id', authReq.pcpUserId)
      .single();

    if (sessionError || !session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const [cloudLogs, localLogs] = await Promise.all([
      fetchCloudSessionLogs(supabase, authReq.pcpUserId, sessionId),
      includeLocal
        ? tryReadLocalTranscript(session.backend_session_id || session.claude_session_id, session.backend)
        : Promise.resolve([]),
    ]);

    const merged = [...cloudLogs, ...localLogs].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    const page = merged.slice(offset, offset + limit);

    res.json({
      session: {
        id: session.id,
        agentId: session.agent_id,
        status: session.status,
        currentPhase: session.current_phase,
        backend: session.backend,
        backendSessionId: session.backend_session_id || session.claude_session_id || null,
        startedAt: session.started_at,
        updatedAt: session.updated_at,
        endedAt: session.ended_at,
      },
      logs: page,
      pagination: {
        total: merged.length,
        limit,
        offset,
        hasMore: offset + page.length < merged.length,
      },
      sources: {
        cloud: cloudLogs.length,
        local: localLogs.length,
      },
    });
  } catch (error) {
    logger.error('Failed to get session logs:', error);
    res.status(500).json({ error: 'Failed to get session logs' });
  }
});

// =============================================================================
// Skills
// =============================================================================

import { getSkillsService, getCloudSkillsService, SkillType } from '../skills';

// Skills registry/installations are currently user-scoped (not workspace-scoped).
// We still read workspace context from AdminAuthRequest for consistency and for
// future workspace-level policy expansion.

/**
 * GET /api/admin/skills
 * List all available skills
 */
router.get('/skills', async (req: Request, res: Response) => {
  try {
    const { type, category, status, search } = req.query;
    const skillsService = getSkillsService();

    const result = skillsService.listSkills({
      type: type as string | undefined,
      category: category as string | undefined,
      status: status as 'available' | 'installed' | 'needs-setup' | 'disabled' | undefined,
      search: search as string | undefined,
    });

    res.json(result);
  } catch (error) {
    logger.error('Failed to list skills:', error);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

/**
 * GET /api/admin/skills/:name
 * Get skill details by name
 */
router.get('/skills/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const skillsService = getSkillsService();

    const skill = skillsService.getSkill(name);
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    res.json(skill);
  } catch (error) {
    logger.error('Failed to get skill:', error);
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

/**
 * POST /api/admin/skills/refresh
 * Refresh skill eligibility checks
 */
router.post('/skills/refresh', async (_req: Request, res: Response) => {
  try {
    const skillsService = getSkillsService();
    const result = skillsService.refreshEligibility();
    res.json(result);
  } catch (error) {
    logger.error('Failed to refresh skills:', error);
    res.status(500).json({ error: 'Failed to refresh skills' });
  }
});

/**
 * GET /api/admin/skills/paths
 * Get skill scan paths
 */
router.get('/skills/paths', async (_req: Request, res: Response) => {
  try {
    const skillsService = getSkillsService();
    const paths = skillsService.getSkillPaths();
    res.json({ paths });
  } catch (error) {
    logger.error('Failed to get skill paths:', error);
    res.status(500).json({ error: 'Failed to get skill paths' });
  }
});

// =============================================================================
// Skills Registry (Cloud)
// =============================================================================

/**
 * GET /api/admin/skills/registry
 * Browse the skills registry
 */
router.get('/skills/registry', async (req: Request, res: Response) => {
  try {
    const { type, category, search, official, limit, offset } = req.query;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const cloudService = getCloudSkillsService(supabase);
    const result = await cloudService.browseRegistry(
      {
        type: type as SkillType | undefined,
        category: category as string | undefined,
        search: search as string | undefined,
        isOfficial: official === 'true' ? true : official === 'false' ? false : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      },
      authReq.pcpUserId
    );

    res.json(result);
  } catch (error) {
    logger.error('Failed to browse skills registry:', error);
    res.status(500).json({ error: 'Failed to browse skills registry' });
  }
});

/**
 * GET /api/admin/skills/registry/:idOrName
 * Get skill details from registry
 */
router.get('/skills/registry/:idOrName', async (req: Request, res: Response) => {
  try {
    const { idOrName } = req.params;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const cloudService = getCloudSkillsService(supabase);
    const skill = await cloudService.getRegistrySkill(idOrName, authReq.pcpUserId);

    if (!skill) {
      res.status(404).json({ error: 'Skill not found in registry' });
      return;
    }

    res.json(skill);
  } catch (error) {
    logger.error('Failed to get registry skill:', error);
    res.status(500).json({ error: 'Failed to get registry skill' });
  }
});

/**
 * POST /api/admin/skills/install
 * Install a skill from the registry
 */
router.post('/skills/install', async (req: Request, res: Response) => {
  try {
    const { skillId, versionPinned, config } = req.body;

    if (!skillId) {
      res.status(400).json({ error: 'skillId is required' });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const cloudService = getCloudSkillsService(supabase);
    const result = await cloudService.installSkill({
      skillId,
      userId: authReq.pcpUserId,
      versionPinned,
      config,
    });

    if (!result.success) {
      res.status(400).json({ error: result.message });
      return;
    }

    res.json(result);
  } catch (error) {
    logger.error('Failed to install skill:', error);
    res.status(500).json({ error: 'Failed to install skill' });
  }
});

/**
 * DELETE /api/admin/skills/install/:skillId
 * Uninstall a skill
 */
router.delete('/skills/install/:skillId', async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const cloudService = getCloudSkillsService(supabase);
    const result = await cloudService.uninstallSkill(skillId, authReq.pcpUserId);

    if (!result.success) {
      res.status(400).json({ error: result.message });
      return;
    }

    res.json(result);
  } catch (error) {
    logger.error('Failed to uninstall skill:', error);
    res.status(500).json({ error: 'Failed to uninstall skill' });
  }
});

/**
 * PATCH /api/admin/skills/install/:installationId
 * Update skill installation (enable/disable, pin version, config)
 */
router.patch('/skills/install/:installationId', async (req: Request, res: Response) => {
  try {
    const { installationId } = req.params;
    const { enabled, versionPinned } = req.body;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const cloudService = getCloudSkillsService(supabase);

    // Toggle enabled
    if (enabled !== undefined) {
      const result = await cloudService.toggleSkill(installationId, authReq.pcpUserId, enabled);
      if (!result.success) {
        res.status(400).json({ error: 'Failed to toggle skill' });
        return;
      }
    }

    // Pin version
    if (versionPinned !== undefined) {
      const result = await cloudService.pinSkillVersion(
        installationId,
        authReq.pcpUserId,
        versionPinned
      );
      if (!result.success) {
        res.status(400).json({ error: 'Failed to pin skill version' });
        return;
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update skill installation:', error);
    res.status(500).json({ error: 'Failed to update skill installation' });
  }
});

/**
 * GET /api/admin/skills/installed
 * Get user's installed skills (merged local + cloud)
 */
router.get('/skills/installed', async (req: Request, res: Response) => {
  try {
    const { type, category, search } = req.query;
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const authReq = req as AdminAuthRequest;

    const cloudService = getCloudSkillsService(supabase);
    const result = await cloudService.listAllSkills(authReq.pcpUserId, {
      type: type as string | undefined,
      category: category as string | undefined,
      search: search as string | undefined,
    });

    res.json(result);
  } catch (error) {
    logger.error('Failed to list installed skills:', error);
    res.status(500).json({ error: 'Failed to list installed skills' });
  }
});

// =============================================================================
// Skills Management (Create/Update/Delete/Fork)
// =============================================================================

/**
 * POST /api/admin/skills/publish
 * Publish a new skill to the registry
 */
router.post('/skills/publish', async (req: Request, res: Response) => {
  try {
    const authReq = req as AdminAuthRequest;
    const {
      name,
      displayName,
      description,
      type,
      category,
      tags,
      emoji,
      version,
      manifest,
      content,
      repositoryUrl,
      isPublic,
    } = req.body;

    if (!name || !displayName || !description || !type || !version || !content) {
      res.status(400).json({
        error: 'Missing required fields: name, displayName, description, type, version, content',
      });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { SkillsRepository } = await import('../skills/repository.js');
    const repository = new SkillsRepository(supabase);

    const skill = await repository.publishSkill({
      name,
      displayName,
      description,
      type,
      category,
      tags,
      emoji,
      version,
      manifest: manifest || {},
      content,
      authorUserId: authReq.pcpUserId,
      repositoryUrl,
      isPublic: isPublic !== false,
    });

    res.json({ success: true, skill });
  } catch (error) {
    logger.error('Failed to publish skill:', error);
    const message = error instanceof Error ? error.message : 'Failed to publish skill';
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /api/admin/skills/manage/:skillId
 * Update an existing skill (creates new version)
 */
router.patch('/skills/manage/:skillId', async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const authReq = req as AdminAuthRequest;
    const {
      displayName,
      description,
      category,
      tags,
      emoji,
      version,
      manifest,
      content,
      changelog,
    } = req.body;

    if (!version) {
      res.status(400).json({ error: 'Version is required for updates' });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { SkillsRepository } = await import('../skills/repository.js');
    const repository = new SkillsRepository(supabase);

    const skill = await repository.updateSkillWithVersion(skillId, authReq.pcpUserId, {
      displayName,
      description,
      category,
      tags,
      emoji,
      version,
      manifest,
      content,
      changelog,
    });

    res.json({ success: true, skill });
  } catch (error) {
    logger.error('Failed to update skill:', error);
    const message = error instanceof Error ? error.message : 'Failed to update skill';
    const status = message.includes('Unauthorized') || message.includes('only modify') ? 403 : 500;
    res.status(status).json({ error: message });
  }
});

/**
 * DELETE /api/admin/skills/manage/:skillId
 * Soft-delete a skill
 */
router.delete('/skills/manage/:skillId', async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const authReq = req as AdminAuthRequest;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { SkillsRepository } = await import('../skills/repository.js');
    const repository = new SkillsRepository(supabase);

    await repository.deleteSkill(skillId, authReq.pcpUserId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete skill:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete skill';
    const status = message.includes('Unauthorized') || message.includes('only modify') ? 403 : 500;
    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/admin/skills/manage/:skillId/deprecate
 * Deprecate a skill
 */
router.post('/skills/manage/:skillId/deprecate', async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const authReq = req as AdminAuthRequest;
    const { message } = req.body;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { SkillsRepository } = await import('../skills/repository.js');
    const repository = new SkillsRepository(supabase);

    const skill = await repository.deprecateSkill({
      skillId,
      userId: authReq.pcpUserId,
      message,
    });

    res.json({ success: true, skill });
  } catch (error) {
    logger.error('Failed to deprecate skill:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to deprecate skill';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/admin/skills/manage/:skillId/fork
 * Fork an existing skill
 */
router.post('/skills/manage/:skillId/fork', async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const authReq = req as AdminAuthRequest;
    const { name, displayName, description, category, tags } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Name is required for fork' });
      return;
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { SkillsRepository } = await import('../skills/repository.js');
    const repository = new SkillsRepository(supabase);

    const skill = await repository.forkSkill({
      sourceSkillId: skillId,
      newName: name,
      newDisplayName: displayName,
      forkerUserId: authReq.pcpUserId,
      customizations: { description, category, tags },
    });

    res.json({ success: true, skill });
  } catch (error) {
    logger.error('Failed to fork skill:', error);
    const message = error instanceof Error ? error.message : 'Failed to fork skill';
    res.status(500).json({ error: message });
  }
});

export default router;
