import qrcodeTerminal from 'qrcode-terminal';

/**
 * Renders `text` (a URL) as an ASCII QR code for terminal display —
 * `detour setup --target android`'s no-`adb` Wi-Fi pairing flow prints one
 * of these so a phone's camera can scan it instead of typing a URL by hand.
 * `qrcode-terminal`'s own API is callback-based even though rendering is
 * synchronous under the hood, so this just wraps it into a plain return
 * value; `{ small: true }` halves the row height (two modules per
 * character) so the code fits comfortably in a normal terminal window.
 */
export function renderQrCode(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(text, { small: true }, resolve);
  });
}
