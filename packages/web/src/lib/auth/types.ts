export type AuthResult = { success: true } | { error: string } | { mcpRedirectUrl: string };

export type OAuthResult = { url: string } | { error: string };
