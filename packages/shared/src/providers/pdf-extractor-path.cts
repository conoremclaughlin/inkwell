/**
 * A module-owned path in both the ESM and CJS builds. TypeScript emits this
 * tiny .cts shim as .cjs in each; no import.meta syntax leaks into CJS.
 */
export const pdfExtractorModulePath = __filename;
