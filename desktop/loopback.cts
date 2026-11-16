import type { IncomingMessage, ServerResponse } from 'node:http';

export function desktopRequestGuard(
  expectedOrigin: string,
): (request: IncomingMessage, response: ServerResponse, next: () => void) => void {
  const expected = new URL(expectedOrigin);
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || !expected.port) {
    throw new Error('Desktop origin must use IPv4 loopback HTTP');
  }
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (
      request.headers.host !== expected.host ||
      (request.headers.origin !== undefined && request.headers.origin !== expected.origin)
    ) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }
    next();
  };
}
