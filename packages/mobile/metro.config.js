// Metro configuration for this package inside the yarn-workspaces monorepo.
// Without this, Metro's server root is detected as the repo root, so Expo Go's
// manifest request for /index.bundle can't resolve the entry.
// See: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch the whole monorepo so edits in sibling packages hot-reload the app.
config.watchFolders = [workspaceRoot];

// 2. Resolve modules from this package first, then the hoisted root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. One React. This app pins its own react (Expo's version) in its own
//    node_modules, while the repo root hoists the web dashboard's. A file in
//    @inklabs/shared (a shared hook such as useThreadHistory) would resolve
//    `react` from where IT lives, and find the root's copy: two Reacts in
//    one bundle, and every shared hook fails with "Invalid hook call".
//    Resolving react as if from this package keeps the whole bundle on the
//    app's copy.
const appOrigin = path.join(projectRoot, 'index.ts');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'react' || moduleName.startsWith('react/')) {
    return context.resolveRequest(
      { ...context, originModulePath: appOrigin },
      moduleName,
      platform
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
