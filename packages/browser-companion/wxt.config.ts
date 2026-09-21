import { defineConfig } from 'wxt';

// Reuse Inkah's WXT build model, not its all-sites content-script grant.
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Inkwell Browser Companion',
    description: 'Share a page deliberately. Review proposed field changes before applying them.',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: { default_title: 'Share this page with Inkwell' },
  },
});
