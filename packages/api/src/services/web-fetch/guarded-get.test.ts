/**
 * The guard, end to end, against local servers.
 *
 * Every refusal is shown by a server that was never reached: without the
 * refusal, the same request would arrive and the test would fail. The
 * servers are ours, on 127.0.0.1 and ::1. To let the guard reach one at all,
 * a test passes a policy that exempts 127.0.0.1 and nothing else; ::1 stays
 * refused, which is what the redirect and rebind cases lean on. The dial
 * fence keeps every socket on loopback, so a regressed refusal fails here
 * without touching a real private or metadata address.
 */

import { once } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installDialFence, type DialFence } from '../../test/dial-fence';
import { refusalFor } from './address-policy';
import {
  guardedGet,
  WebFetchRefusal,
  type GuardNetwork,
  type ResolvedAddress,
} from './guarded-get';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface TestServer {
  port: number;
  hits: IncomingMessage[];
  /** TCP connections accepted, whether or not a request followed. */
  connections: () => number;
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(host: '127.0.0.1' | '::1', handler: Handler, port = 0) {
  const hits: IncomingMessage[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  let connections = 0;
  server.on('connection', (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(port, host);
  await once(server, 'listening');
  const started: TestServer = {
    port: (server.address() as AddressInfo).port,
    hits,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(started);
  return started;
}

const ok: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reached');
};

/** The test policy: 127.0.0.1 is let through, everything else as in production. */
const exempt127 = (address: string) => (address === '127.0.0.1' ? null : refusalFor(address));

function resolver(table: Record<string, ResolvedAddress[]>) {
  const calls: string[] = [];
  const resolve: GuardNetwork['resolve'] = async (hostname) => {
    calls.push(hostname);
    const answers = table[hostname];
    if (!answers) throw new Error(`test resolver has no answer for ${hostname}`);
    return answers;
  };
  return { resolve, calls };
}

async function refusal(promise: Promise<unknown>): Promise<WebFetchRefusal> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(WebFetchRefusal);
  return error as WebFetchRefusal;
}

let fence: DialFence;

beforeAll(() => {
  fence = installDialFence();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(() => {
  fence.restore();
});

describe('the dial fence (the harness these tests rely on)', () => {
  it('stops a dial to a non-loopback address before it leaves', async () => {
    // 192.0.2.1 is TEST-NET-1: never routed, so even a broken fence reaches nothing.
    const socket = net.connect({ host: '192.0.2.1', port: 9 });
    const [error] = await once(socket, 'error');
    expect((error as Error).message).toContain('dial fence');
  });
});

describe('guardedGet reaches a server it is allowed to', () => {
  it('fetches from the exempted address (the control for every refusal below)', async () => {
    const server = await startServer('127.0.0.1', ok);
    const response = await guardedGet(`http://127.0.0.1:${server.port}/page`, {
      network: { refusalFor: exempt127 },
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('reached');
    expect(server.hits).toHaveLength(1);
  });
});

describe('guardedGet refuses loopback', () => {
  it.each([
    (port: number) => `http://127.0.0.1:${port}/`,
    (port: number) => `http://127.1:${port}/`,
    (port: number) => `http://0x7f.0.0.1:${port}/`,
    (port: number) => `http://2130706433:${port}/`,
    (port: number) => `http://[::ffff:127.0.0.1]:${port}/`,
  ])('refuses the IPv4 loopback literal %#, and the server is never reached', async (url) => {
    const server = await startServer('127.0.0.1', ok);
    const refused = await refusal(guardedGet(url(server.port)));
    expect(refused.range).toBe('loopback');
    expect(server.hits).toHaveLength(0);
  });

  it('refuses [::1], and the server there is never reached', async () => {
    const server = await startServer('::1', ok);
    const refused = await refusal(guardedGet(`http://[::1]:${server.port}/`));
    expect(refused.range).toBe('loopback');
    expect(server.hits).toHaveLength(0);
  });

  it('refuses localhost by name, without resolving it', async () => {
    const server = await startServer('127.0.0.1', ok);
    const { resolve, calls } = resolver({ localhost: [{ address: '127.0.0.1', family: 4 }] });
    const refused = await refusal(
      guardedGet(`http://localhost:${server.port}/`, { network: { resolve } })
    );
    expect(refused.message).toContain('local or internal name');
    expect(calls).toHaveLength(0);
    expect(server.hits).toHaveLength(0);
  });

  it('refuses a public-looking name that resolves to loopback', async () => {
    const server = await startServer('127.0.0.1', ok);
    const { resolve } = resolver({ 'innocent.test': [{ address: '127.0.0.1', family: 4 }] });
    const refused = await refusal(
      guardedGet(`http://innocent.test:${server.port}/`, { network: { resolve } })
    );
    expect(refused.range).toBe('loopback');
    expect(refused.message).not.toContain('127.0.0.1');
    expect(server.hits).toHaveLength(0);
  });

  it('refuses a name when any one of its answers is refused', async () => {
    const server = await startServer('127.0.0.1', ok);
    const { resolve } = resolver({
      'mixed.test': [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
    });
    const refused = await refusal(
      guardedGet(`http://mixed.test:${server.port}/`, {
        network: { resolve, refusalFor: exempt127 },
      })
    );
    expect(refused.range).toBe('loopback');
    expect(server.hits).toHaveLength(0);
  });
});

describe('guardedGet refuses private, link-local and metadata addresses', () => {
  it.each([
    ['10.0.0.5', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.100.100.200', 'shared'],
    ['fd00:ec2::254', 'unique-local'],
    ['fe80::1', 'link-local'],
  ])('refuses a name resolving to %s (%s)', async (address, range) => {
    const { resolve } = resolver({
      'target.test': [{ address, family: address.includes(':') ? 6 : 4 }],
    });
    const refused = await refusal(guardedGet('http://target.test/', { network: { resolve } }));
    expect(refused.range).toBe(range);
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://[fd00:ec2::254]/latest/meta-data/', 'unique-local'],
    ['http://10.0.0.5/', 'private'],
  ])('refuses the literal %s', async (url, range) => {
    const refused = await refusal(guardedGet(url));
    expect(refused.range).toBe(range);
  });

  it('refuses metadata.google.internal by name', async () => {
    const { resolve, calls } = resolver({});
    await refusal(guardedGet('http://metadata.google.internal/', { network: { resolve } }));
    expect(calls).toHaveLength(0);
  });
});

describe('guardedGet connects only to the address it checked', () => {
  it('ignores a DNS answer that changes after the check (rebind)', async () => {
    const good = await startServer('127.0.0.1', ok);
    const bad = await startServer('::1', ok, good.port);
    let calls = 0;
    const resolve: GuardNetwork['resolve'] = async () => {
      calls += 1;
      return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '::1', family: 6 }];
    };
    const response = await guardedGet(`http://rebind.test:${good.port}/`, {
      network: { resolve, refusalFor: exempt127 },
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(good.hits).toHaveLength(1);
    expect(bad.hits).toHaveLength(0);
  });
});

describe('guardedGet checks every redirect hop', () => {
  /** A server on 127.0.0.1 whose /start redirects to `location()`, read per request. */
  async function redirectingTo(location: () => string) {
    return startServer('127.0.0.1', (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: location(), 'set-cookie': 'session=secret; Path=/' });
        res.end();
      } else {
        ok(req, res);
      }
    });
  }

  it('refuses a redirect to loopback, and the server there is never reached', async () => {
    const target = await startServer('::1', ok);
    const origin = await redirectingTo(() => `http://[::1]:${target.port}/`);
    const refused = await refusal(
      guardedGet(`http://127.0.0.1:${origin.port}/start`, { network: { refusalFor: exempt127 } })
    );
    expect(refused.range).toBe('loopback');
    expect(origin.hits).toHaveLength(1);
    expect(target.hits).toHaveLength(0);
  });

  it('refuses a redirect to the metadata address', async () => {
    const origin = await redirectingTo(() => 'http://169.254.169.254/latest/meta-data/');
    const refused = await refusal(
      guardedGet(`http://127.0.0.1:${origin.port}/start`, { network: { refusalFor: exempt127 } })
    );
    expect(refused.range).toBe('link-local');
  });

  it('refuses a redirect to a name that resolves to a private address', async () => {
    const origin = await redirectingTo(() => 'http://intranet.test/');
    const { resolve } = resolver({ 'intranet.test': [{ address: '10.1.2.3', family: 4 }] });
    const refused = await refusal(
      guardedGet(`http://127.0.0.1:${origin.port}/start`, {
        network: { resolve, refusalFor: exempt127 },
      })
    );
    expect(refused.range).toBe('private');
  });

  it.each([
    ['localhost', (port: number) => `http://localhost:${port}/`],
    ['file', () => 'file:///etc/passwd'],
    // A host that passes the address check, so only the scheme check refuses it.
    ['ftp on an allowed host', (port: number) => `ftp://127.0.0.1:${port}/`],
    ['credentials', (port: number) => `http://user:pass@127.0.0.1:${port}/`],
  ])('refuses a redirect to %s', async (_label, location) => {
    let port = 0;
    const origin = await redirectingTo(() => location(port));
    port = origin.port;
    await refusal(
      guardedGet(`http://127.0.0.1:${origin.port}/start`, { network: { refusalFor: exempt127 } })
    );
    expect(origin.hits).toHaveLength(1);
  });

  it('follows an allowed redirect and sends back no cookie or credential', async () => {
    const server = await startServer('127.0.0.1', (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/next', 'set-cookie': 'session=secret; Path=/' });
        res.end();
      } else {
        ok(req, res);
      }
    });
    const response = await guardedGet(`http://127.0.0.1:${server.port}/start`, {
      network: { refusalFor: exempt127 },
    });
    expect(response.status).toBe(200);
    expect(response.redirects).toBe(1);
    expect(response.finalUrl).toBe(`http://127.0.0.1:${server.port}/next`);
    expect(server.hits.map((hit) => hit.url)).toEqual(['/start', '/next']);
    for (const hit of server.hits) {
      expect(hit.headers.cookie).toBeUndefined();
      expect(hit.headers.authorization).toBeUndefined();
      expect(Object.keys(hit.headers).sort()).toEqual([
        'accept',
        'accept-encoding',
        'accept-language',
        'connection',
        'host',
        'user-agent',
      ]);
    }
  });

  it('stops after the redirect limit', async () => {
    const server = await startServer('127.0.0.1', (req, res) => {
      const step = Number(req.url?.slice(1)) || 0;
      res.writeHead(302, { location: `/${step + 1}` });
      res.end();
    });
    await expect(
      guardedGet(`http://127.0.0.1:${server.port}/0`, {
        network: { refusalFor: exempt127 },
        limits: { maxRedirects: 3 },
      })
    ).rejects.toThrow('Too many redirects (limit 3)');
    expect(server.hits).toHaveLength(4);
  });

  it('stops a redirect loop', async () => {
    const server = await startServer('127.0.0.1', (req, res) => {
      res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' });
      res.end();
    });
    await expect(
      guardedGet(`http://127.0.0.1:${server.port}/a`, { network: { refusalFor: exempt127 } })
    ).rejects.toThrow('Redirect loop');
  });
});

describe('guardedGet refuses URLs it never fetches', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'data:text/plain,hi',
    'not a url',
  ])('refuses %s', async (url) => {
    await refusal(guardedGet(url));
  });

  it('refuses a URL carrying a username and password before connecting', async () => {
    const server = await startServer('127.0.0.1', ok);
    await refusal(
      guardedGet(`http://user:pass@127.0.0.1:${server.port}/`, {
        network: { refusalFor: exempt127 },
      })
    );
    expect(server.hits).toHaveLength(0);
  });
});

describe('guardedGet caps size and time', () => {
  it('stops reading at the byte cap', async () => {
    const server = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < 3_000_000) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    const response = await guardedGet(`http://127.0.0.1:${server.port}/`, {
      network: { refusalFor: exempt127 },
      limits: { maxBodyBytes: 100_000 },
    });
    expect(response.body.length).toBe(100_000);
    expect(response.bodyTruncated).toBe(true);
  });

  it('caps a compressed body after decompression (a gzip bomb stops at the cap)', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(20_000_000));
    expect(bomb.length).toBeLessThan(100_000);
    const server = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    const response = await guardedGet(`http://127.0.0.1:${server.port}/`, {
      network: { refusalFor: exempt127 },
      limits: { maxBodyBytes: 500_000 },
    });
    expect(response.body.length).toBe(500_000);
    expect(response.bodyTruncated).toBe(true);
  });

  it('reads a small gzip body whole', async () => {
    const server = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('compressed hello'));
    });
    const response = await guardedGet(`http://127.0.0.1:${server.port}/`, {
      network: { refusalFor: exempt127 },
    });
    expect(response.body.toString()).toBe('compressed hello');
    expect(response.bodyTruncated).toBe(false);
  });

  it('gives up at the deadline when the server never answers', async () => {
    const server = await startServer('127.0.0.1', () => {
      /* never responds */
    });
    const started = Date.now();
    await expect(
      guardedGet(`http://127.0.0.1:${server.port}/`, {
        network: { refusalFor: exempt127 },
        limits: { timeoutMs: 300 },
      })
    ).rejects.toThrow('timed out after 300ms');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('gives up at the deadline when the body drips', async () => {
    const server = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const timer = setInterval(() => res.write('.'), 50);
      res.on('close', () => clearInterval(timer));
    });
    await expect(
      guardedGet(`http://127.0.0.1:${server.port}/`, {
        network: { refusalFor: exempt127 },
        limits: { timeoutMs: 400 },
      })
    ).rejects.toThrow('timed out after 400ms');
  });

  it('settles promptly when a server answers 101 Switching Protocols (Lumen, PR #792)', async () => {
    const sockets = new Set<net.Socket>();
    const raw = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () =>
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
        )
      );
    });
    raw.listen(0, '127.0.0.1');
    await once(raw, 'listening');
    try {
      const port = (raw.address() as AddressInfo).port;
      const outcome = guardedGet(`http://127.0.0.1:${port}/`, {
        network: { refusalFor: exempt127 },
        limits: { timeoutMs: 300 },
      }).then(
        () => 'resolved',
        (error: Error) => error.message
      );
      const pending = new Promise((resolve) => setTimeout(() => resolve('still pending'), 2_000));
      const result = await Promise.race([outcome, pending]);
      expect(result).toContain('101');
      // The server's end of the upgraded socket is closed, not left open.
      await expect
        .poll(() => [...sockets].every((socket) => socket.destroyed || socket.readableEnded))
        .toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });

  it('starts no connection when the lookup answers after the deadline', async () => {
    const server = await startServer('127.0.0.1', ok);
    const resolve: GuardNetwork['resolve'] = () =>
      new Promise((answer) => setTimeout(() => answer([{ address: '127.0.0.1', family: 4 }]), 300));
    await expect(
      guardedGet(`http://late.test:${server.port}/`, {
        network: { resolve, refusalFor: exempt127 },
        limits: { timeoutMs: 100 },
      })
    ).rejects.toMatchObject({ reason: 'timeout' });
    // Wait past the late answer, then check no connection was even opened.
    await new Promise((settle) => setTimeout(settle, 600));
    expect(server.connections()).toBe(0);
    expect(server.hits).toHaveLength(0);
  });

  it('gives up at the deadline when the lookup hangs', async () => {
    const resolve: GuardNetwork['resolve'] = () => new Promise(() => undefined);
    await expect(
      guardedGet('http://slow-dns.test/', {
        network: { resolve },
        limits: { timeoutMs: 200 },
      })
    ).rejects.toMatchObject({
      message: 'web_fetch timed out after 200ms',
      reason: 'timeout',
      // The hop never reached its own catch; the guard still knows where it was.
      hopUrl: 'http://slow-dns.test/',
    });
  });
});

describe('guardedGet names every failure', () => {
  it('gives a deadline its reason and the hop it was on', async () => {
    const server = await startServer('127.0.0.1', (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/slow?token=x' });
        res.end();
      }
      // /slow never answers
    });
    await expect(
      guardedGet(`http://127.0.0.1:${server.port}/start`, {
        network: { refusalFor: exempt127 },
        limits: { timeoutMs: 300 },
      })
    ).rejects.toMatchObject({
      reason: 'timeout',
      hopUrl: `http://127.0.0.1:${server.port}/slow?token=x`,
    });
  });

  it("gives a socket failure Node's code", async () => {
    await expect(
      guardedGet('http://127.0.0.1:1/', { network: { refusalFor: exempt127 } })
    ).rejects.toMatchObject({ name: 'WebFetchError', reason: 'network', code: 'ECONNREFUSED' });
  });

  it('gives redirect, upgrade and refusal failures their own reasons', async () => {
    const server = await startServer('127.0.0.1', (req, res) => {
      res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' });
      res.end();
    });
    await expect(
      guardedGet(`http://127.0.0.1:${server.port}/a`, { network: { refusalFor: exempt127 } })
    ).rejects.toMatchObject({ reason: 'redirect-loop' });
    await expect(guardedGet('ftp://example.com/')).rejects.toMatchObject({ reason: 'scheme' });
    await expect(guardedGet('http://localhost/')).rejects.toMatchObject({ reason: 'blocked-name' });
    await expect(guardedGet('http://10.0.0.1/')).rejects.toMatchObject({
      reason: 'blocked-address',
      range: 'private',
    });
  });
});

describe('guardedGet returns non-redirect statuses', () => {
  it('returns a 404 with its body', async () => {
    const server = await startServer('127.0.0.1', (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nothing here');
    });
    const response = await guardedGet(`http://127.0.0.1:${server.port}/`, {
      network: { refusalFor: exempt127 },
    });
    expect(response.status).toBe(404);
    expect(response.body.toString()).toBe('nothing here');
  });
});
