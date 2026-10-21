import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { postWebhook } from './webhook-worker.js';

describe('webhook transport', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('refuses hosts that resolve to private addresses at connect time', async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    await expect(postWebhook('http://localhost:9/hook', {}, '{}')).rejects.toThrow('private_webhook_target');
  });

  it('posts the body and reports the status without following redirects', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = 'true';
    process.env.NODE_ENV = 'test';
    let received = '';
    const server = createServer((request, response) => {
      request.on('data', (chunk) => { received += chunk; });
      request.on('end', () => response.writeHead(302, { location: 'http://127.0.0.1:1/' }).end());
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const { port } = server.address() as { port: number };
    try {
      expect(await postWebhook(`http://localhost:${port}/hook`, { 'content-type': 'application/json' }, '{"ok":true}')).toBe(302);
      expect(received).toBe('{"ok":true}');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
