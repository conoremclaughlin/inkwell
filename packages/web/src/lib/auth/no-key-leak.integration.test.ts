import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const WEB_ROOT = path.resolve(__dirname, '../../..');

describe('publishable key leak prevention', () => {
  it('source code has no NEXT_PUBLIC_SUPABASE references', () => {
    // Check all source files (not build output, node_modules, or test files)
    const result = execSync(
      `grep -r "NEXT_PUBLIC_SUPABASE" src/ --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" -l 2>/dev/null || true`,
      { cwd: WEB_ROOT, encoding: 'utf-8' }
    );
    expect(result.trim()).toBe('');
  });

  it('source code has no imports of @/lib/supabase/client', () => {
    const result = execSync(
      `grep -r "from.*supabase/client" src/ --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" -l 2>/dev/null || true`,
      { cwd: WEB_ROOT, encoding: 'utf-8' }
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

  it('build output does not contain the publishable key', () => {
    // Check that the production build doesn't embed the key
    // This uses the actual .env.local key pattern (not the literal key, just the prefix)
    const buildServerDir = path.join(WEB_ROOT, '.next/server');
    const buildStaticDir = path.join(WEB_ROOT, '.next/static');

    if (!fs.existsSync(buildServerDir)) {
      // Build hasn't been run — skip gracefully
      console.log('Skipping build output check — .next/server not found (run `yarn build` first)');
      return;
    }

    // Check server output
    const serverResult = execSync(
      `grep -r "sb_publishable_" ${buildServerDir} -l 2>/dev/null || true`,
      { encoding: 'utf-8' }
    );
    expect(serverResult.trim()).toBe('');

    // Check static output (client bundles)
    if (fs.existsSync(buildStaticDir)) {
      const staticResult = execSync(
        `grep -r "sb_publishable_" ${buildStaticDir} -l 2>/dev/null || true`,
        { encoding: 'utf-8' }
      );
      expect(staticResult.trim()).toBe('');
    }
  });
});
