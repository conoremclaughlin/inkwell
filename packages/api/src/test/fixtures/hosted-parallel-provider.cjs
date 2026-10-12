/** Token-free provider protocol twin. Only an owned test fixture invokes it. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
async function main() {
  if (args.includes('list')) {
    emit([]);
    return;
  }
  const cwd = process.cwd();
  const fixture = JSON.parse(await fs.readFile(path.join(cwd, 'parallel-fixture.json'), 'utf8'));
  const token = JSON.parse(
    Buffer.from(process.env.INK_ACCESS_TOKEN.split('.')[1], 'base64url').toString()
  );
  const context = JSON.parse(Buffer.from(process.env.INK_CONTEXT, 'base64url').toString());
  const evidence = {
    pid: process.pid,
    startedAt: Date.now(),
    cwd,
    sessionId: token.sessionId,
    sbSlug: token.sbSlug,
    studioId: context.studioId,
    context,
    token: { sub: token.sub, sbSlug: token.sbSlug, sessionId: token.sessionId },
    credentialFingerprint: createHash('sha256').update(process.env.INK_ACCESS_TOKEN).digest('hex'),
    // Paths/flags only, never config contents or the raw argv (which holds prompts).
    mcpConfig: args.includes('--mcp-config') ? args[args.indexOf('--mcp-config') + 1] : null,
    nativeTools: args.includes('--tools') ? args[args.indexOf('--tools') + 1] : null,
    leakedServerCredential: Boolean(process.env.SUPABASE_SECRET_KEY || process.env.JWT_SECRET),
  };
  const audit = path.join(cwd, `launch-${process.pid}.json`);
  await fs.writeFile(audit, JSON.stringify(evidence));
  const deadline = Date.now() + 20000;
  while (
    !(await fs.stat(path.join(cwd, 'release')).then(
      () => true,
      () => false
    ))
  ) {
    if (Date.now() > deadline) throw new Error('Fixture barrier expired');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let prompt = '';
  if (args.includes('exec')) prompt = args.at(-1);
  else for await (const chunk of process.stdin) prompt += chunk;
  const tool = (name, data) =>
    '\n```ink-tool\n' + JSON.stringify({ tool: name, args: data }) + '\n```';
  // The adapter can use stdin or argv; no provider is contacted in this twin.
  const counter = path.join(cwd, 'counter');
  const n = Number(await fs.readFile(counter, 'utf8').catch(() => '0'));
  await fs.writeFile(counter, String(n + 1));
  const text =
    n % 2 === 0
      ? tool('remember', { sbSlug: fixture.sbSlug, content: fixture.marker, salience: 'low' }) +
        (fixture.failTool ? tool('remember', { sbSlug: fixture.sbSlug, content: 17 }) : '') +
        (fixture.threadKey ? tool('bash', { command: 'true' }) : '') +
        tool('send_to_inbox', {
          senderSlug: fixture.sbSlug,
          recipientSlug: fixture.threadKey ? fixture.sbSlug : 'sink',
          ...(fixture.threadKey ? { threadKey: fixture.threadKey } : {}),
          content: fixture.marker,
          trigger: false,
        })
      : fixture.marker + tool('signal_status', { status: 'completed' });
  if (args.includes('exec')) {
    emit({ type: 'item.completed', item: { id: 'fixture', type: 'agent_message', text } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    emit({
      type: 'assistant',
      session_id: fixture.nativeId,
      message: { content: [{ type: 'text', text }] },
    });
    emit({ type: 'result', subtype: 'success', session_id: fixture.nativeId, result: text });
  }
  await fs.writeFile(audit, JSON.stringify({ ...evidence, endedAt: Date.now() }));
}
main().catch(() => {
  process.stderr.write('parallel provider fixture failed\n');
  process.exitCode = 1;
});
