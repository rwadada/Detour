import qrcodeFactory from 'qrcode-generator';

/** A QR code as a square grid of dark/light modules — `matrix[row][col]` is `true` for a dark (foreground) module. */
export type QrMatrix = boolean[][];

/**
 * Builds the module grid for a QR code encoding `text` (issue #24's sidebar
 * Proxy URL QR code, for pointing a mobile device at the proxy without
 * typing the URL by hand). Type number `0` lets `qrcode-generator` pick the
 * smallest size that fits `text` automatically — a proxy URL is short and
 * fixed-shape enough that manually tuning this would only add a magic
 * number with no benefit. `'M'` (~15% error correction) is the library's
 * suggested default and plenty for a URL rendered at a few hundred pixels.
 */
export function buildQrMatrix(text: string): QrMatrix {
  const qr = qrcodeFactory(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const matrix: QrMatrix = [];
  for (let row = 0; row < count; row++) {
    const cells: boolean[] = [];
    for (let col = 0; col < count; col++) cells.push(qr.isDark(row, col));
    matrix.push(cells);
  }
  return matrix;
}
