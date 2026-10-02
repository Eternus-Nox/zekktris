/**
 * Whether passkeys can work on this page. The browser has to support WebAuthn,
 * AND the server has to be reached by a domain name: WebAuthn's relying-party
 * id can't be an IP address, so a self-hosted server reached by its bare
 * public IP (install.sh --ip) or a LAN IP can't offer passkeys at all.
 * localhost is allowed (it's what dev uses).
 */
export function passkeysAvailable(): boolean {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
    return false;
  }
  const host = window.location.hostname;
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIPv6 = host.includes(':') || host.startsWith('[');
  return !isIPv4 && !isIPv6;
}
