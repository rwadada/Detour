import net from 'node:net';

/**
 * Probe whether `port` is free on `host` before handing it to
 * http-mitm-proxy. The underlying library doesn't surface listen
 * errors (e.g. EADDRINUSE) through its callback, so without this
 * check a port collision would crash the process with an unhandled
 * 'error' event instead of a clean CLI error message.
 */
export function assertPortAvailable(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`ポート ${port} は既に使用されています。別の --port を指定してください。`));
      } else {
        reject(err);
      }
    });
    tester.listen({ port, host }, () => {
      tester.close(() => resolve());
    });
  });
}
