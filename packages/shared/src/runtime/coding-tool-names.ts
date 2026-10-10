/** The existing in-process coding surface, shared by dispatch and discovery. */
const PI_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'write',
  'bash',
  'grep',
  'find',
  'ls',
]);
export const VIEW_IMAGE_TOOL = 'view_image';
export function isPiTool(name: string): boolean {
  return PI_TOOL_NAMES.has(name);
}
export function getPiToolNames(): string[] {
  return [...PI_TOOL_NAMES];
}
