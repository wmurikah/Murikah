/**
 * A minimal S3-compatible object store for the smoke test (Build Prompt 54).
 *
 * The R2 connector proves a connection by writing a probe object and removing
 * it again, and activation now depends on that test passing. Without somewhere
 * for it to succeed there is no way to assert the thing this build is about: a
 * tested provider becoming active and the evidence gate opening. So the smoke
 * run points the connection's Endpoint at this server instead of Cloudflare.
 *
 * It is deliberately not an S3 implementation. It answers the four verbs the
 * provider actually uses against a path of `/<bucket>/<key>`, keeps the bytes
 * in a Map, and ignores the SigV4 query string: the signature is unit-tested in
 * sigv4.test.ts, and re-checking it here would test node's crypto rather than
 * the application.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export class FakeS3Server {
  private server: Server | null = null;
  /** Every object written, by `<bucket>/<key>`, so a test can assert on them. */
  readonly objects = new Map<string, Buffer>();

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          this.objects.set(path, Buffer.concat(chunks));
          res.writeHead(200).end();
        });
        return;
      }
      const body = this.objects.get(path);
      if (method === 'DELETE') {
        this.objects.delete(path);
        res.writeHead(204).end();
        return;
      }
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-length': String(body.byteLength) });
      res.end(method === 'HEAD' ? undefined : body);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
