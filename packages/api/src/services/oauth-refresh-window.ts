/**
 * How close to expiry a stored Google access token stops being trusted and is
 * refreshed before use. One constant for both credential sources — the cloud
 * row in `connected_accounts` and the desktop store — so their "active" versus
 * "refresh_required" verdicts mean the same thing.
 */
export const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
