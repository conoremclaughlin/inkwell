import { execFile } from 'child_process';

/** macOS browser launch; URL bytes are never interpreted by a shell. */
export function openBrowser(url: string): void {
  execFile('open', [url]);
}
