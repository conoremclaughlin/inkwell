import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const WEB_ROOT = path.resolve(__dirname, '../../..');

// grep's status 1 means no matches; IO/tool failures must fail the check.
function matchingFiles(pattern: string, directory: string, filters: string[] = []): string {
  try {
    return execFileSync('grep', ['-r', '-l', ...filters, '--', pattern, directory], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

const SOURCE_FILTERS = [
  '--include=*.ts',
  '--include=*.tsx',
  '--exclude=*.test.ts',
  '--exclude=*.test.tsx',
];

describe('publishable key leak prevention', () => {
  it('source code has no NEXT_PUBLIC_SUPABASE references', () => {
    // Check all source files (not build output, node_modules, or test files)
    const result = matchingFiles(
      'NEXT_PUBLIC_SUPABASE',
      path.join(WEB_ROOT, 'src'),
      SOURCE_FILTERS
    );
    expect(result.trim()).toBe('');
  });

  it('source code has no imports of @/lib/supabase/client', () => {
    const result = matchingFiles(
      'from.*supabase/client',
      path.join(WEB_ROOT, 'src'),
      SOURCE_FILTERS
    );
    expect(result.trim()).toBe('');
  });

  it('browser Supabase client file does not exist', () => {
    const clientPath = path.join(WEB_ROOT, 'src/lib/supabase/client.ts');
    expect(fs.existsSync(clientPath)).toBe(false);
  });

  it('.env.example uses server-only env vars', () => {
    const envExample = fs.readFileSync(path.join(WEB_ROOT, '.env.example'), 'utf-8');
    expect(envExample).not.toContain('NEXT_PUBLIC_SUPABASE');
    expect(envExample).toContain('SUPABASE_URL');
    expect(envExample).toContain('SUPABASE_PUBLISHABLE_KEY');
  });

  it('server.ts uses server-only env vars', () => {
    const serverTs = fs.readFileSync(path.join(WEB_ROOT, 'src/lib/supabase/server.ts'), 'utf-8');
    expect(serverTs).not.toContain('NEXT_PUBLIC_SUPABASE');
    expect(serverTs).toContain('process.env.SUPABASE_URL');
    expect(serverTs).toContain('process.env.SUPABASE_PUBLISHABLE_KEY');
  });

  it('middleware.ts uses server-only env vars', () => {
    const middlewareTs = fs.readFileSync(
      path.join(WEB_ROOT, 'src/lib/supabase/middleware.ts'),
      'utf-8'
    );
    expect(middlewareTs).not.toContain('NEXT_PUBLIC_SUPABASE');
    expect(middlewareTs).toContain('process.env.SUPABASE_URL');
    expect(middlewareTs).toContain('process.env.SUPABASE_PUBLISHABLE_KEY');
  });

  it('build output does not contain the publishable key', (context) => {
    // Check that the production build doesn't embed the key
    // Match a public credential prefix; never read a real environment file.
    const buildServerDir = path.join(WEB_ROOT, '.next/server');
    const buildStaticDir = path.join(WEB_ROOT, '.next/static');

    if (!fs.existsSync(buildServerDir)) {
      // Build hasn't been run — skip gracefully
      context.skip();
      return;
    }

    // Check server output
    const serverResult = matchingFiles('sb_publishable_', buildServerDir);
    expect(serverResult.trim()).toBe('');

    // Check static output (client bundles)
    if (fs.existsSync(buildStaticDir)) {
      const staticResult = matchingFiles('sb_publishable_', buildStaticDir);
      expect(staticResult.trim()).toBe('');
    }
  });
});
