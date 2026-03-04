import { describe, expect, it } from 'vitest';
import { registerAllTools } from './index';

class FakeMcpServer {
  public registeredTools: string[] = [];

  registerTool(name: string): void {
    this.registeredTools.push(name);
  }
}

describe('registerAllTools lifecycle visibility', () => {
  it('omits internal lifecycle tools when includeInternalLifecycleTools=false', () => {
    const server = new FakeMcpServer();
    const dataComposer = { getClient: () => ({}) };
    registerAllTools(server as unknown as any, dataComposer as any, {
      includeInternalLifecycleTools: false,
    });

    expect(server.registeredTools).not.toContain('start_session');
    expect(server.registeredTools).not.toContain('end_session');
    expect(server.registeredTools).toContain('update_session_phase');
  });

  it('includes lifecycle tools when includeInternalLifecycleTools=true', () => {
    const server = new FakeMcpServer();
    const dataComposer = { getClient: () => ({}) };
    registerAllTools(server as unknown as any, dataComposer as any, {
      includeInternalLifecycleTools: true,
    });

    expect(server.registeredTools).toContain('start_session');
    expect(server.registeredTools).toContain('end_session');
    expect(server.registeredTools).not.toContain('log_session');
    expect(server.registeredTools).toContain('update_session_phase');
  });
});
