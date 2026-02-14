/**
 * Best-effort bootstrap of PCP user + personal workspace after auth.
 * This intentionally swallows errors so login/signup UX is never blocked.
 */
export async function provisionPcpUserAndWorkspace(accessToken: string): Promise<void> {
  if (!accessToken) return;
  if (process.env.NODE_ENV === 'test') return;

  const apiUrl = process.env.API_URL || `http://localhost:${process.env.PCP_PORT_BASE || 3001}`;

  try {
    const response = await fetch(`${apiUrl}/api/admin/workspaces`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      console.warn('[auth/provision] failed to provision personal workspace', {
        status: response.status,
      });
    }
  } catch (error) {
    console.warn('[auth/provision] failed to provision personal workspace', { error });
  }
}
