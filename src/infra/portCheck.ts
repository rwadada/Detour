import net from 'node:net';

/**
 * Probe whether `port` is free on `host` before handing it to
 * `ProxyEngine.listen`. A bare `http.Server.listen()` doesn't surface a
 * clean error through its callback on EADDRINUSE, so without this check a
 * port collision would crash the process with an unhandled 'error' event
 * instead of a clean CLI error message.
 */
export function assertPortAvailable(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Specify a different --port.`));
      } else {
        reject(err);
      }
    });
    tester.listen({ port, host }, () => {
      tester.close(() => resolve());
    });
  });
}
