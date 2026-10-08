/** The prompt uses the same local catalog as describe_tool. */
import { renderLocalToolGroup } from './local-tool-catalog.js';

export function buildLocalToolInstruction(opts: { audience: 'parent' | 'clone' }): string {
  const forClone = opts.audience === 'clone';

  const header = [
    'IMPORTANT: To call tools, you MUST emit fenced code blocks in this exact format:',
    '',
    '```ink-tool',
    '{"tool":"tool_name","args":{}}',
    '```',
    '',
    'Do NOT use ToolSearch, mcp__inkwell__*, or native MCP tool calling — those will not work in this runtime. Only the fenced block format above will execute tools. You can emit multiple ink-tool blocks in one response.',
    '',
    'After emitting your ink-tool block(s), END your response and wait. The ink runtime executes the calls and sends the real results back in a following message that begins "[Tool results from previous turn]". NEVER write that section yourself: only the runtime writes tool results, anything you write after your fences is discarded unread, and results you compose are not real, however plausible they look.',
    '',
  ].join('\n');

  // Only names are listed here: a native MCP session is handed every schema,
  // this runtime is not, so the parameters live behind describe_tool. Say so,
  // or the model guesses field names (Oct 7: `sbSlug` on send_to_inbox).
  const lookup =
    'describe_tool({}) lists every Inkwell tool; before calling one you have not used yet, call describe_tool({"name": "<tool>"}) for its exact parameters, which ones are required, and their names. Do not guess a parameter name.';
  const inkwell = forClone
    ? `Inkwell tools (server round-trip, read-only for you): recall, get_artifact, list_artifacts, search_artifacts, list_tasks, list_projects, get_session, list_sessions, get_activity, search_links, bootstrap, and more. Write-side tools (remember, send_to_inbox, create_task, …) are unavailable — report findings instead. ${lookup}`
    : `Inkwell tools (server round-trip): get_inbox, recall, remember, list_tasks, send_response, save_link, create_task, update_session_state, bootstrap, web_fetch (read a web page as text, no shell needed), and more. ${lookup}`;

  const codingTools = renderLocalToolGroup('coding', opts.audience);
  const clientLocal = renderLocalToolGroup('client-local', opts.audience);
  const spawn = renderLocalToolGroup('delegation', opts.audience);

  return [header, inkwell, '', codingTools, '', clientLocal, ...(forClone ? [] : ['', spawn])].join(
    '\n'
  );
}
