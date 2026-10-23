import type { NetworkInterfaceInfo } from 'node:os';

/** Private, loopback and link-local IPv4 ranges. */
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|0\.)/;

/** Virtual interfaces (containers, VPNs) that Plex can't reach Homebridge through. */
const IGNORED_INTERFACES = /^(docker|veth|virbr|br-|vnet|tun|tap|utun|lo|zt|tailscale|wg)/;

function toNumber(ip: string): number {
  return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0) >>> 0;
}

/** Extracts an IPv4 address from a server URL, including Plex's `10-0-0-2.<id>.plex.direct` names. */
export function serverAddress(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return host;
    }
    const direct = /^(\d+)-(\d+)-(\d+)-(\d+)\./.exec(host);
    return direct ? direct.slice(1, 5).join('.') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks this machine's IPv4 address for Plex to call: one on the same subnet as a server when
 * possible, otherwise the first ordinary network interface.
 */
export function lanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, serverUrls: readonly string[]): string | undefined {
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !IGNORED_INTERFACES.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal);
  for (const url of serverUrls) {
    const target = serverAddress(url);
    if (!target) {
      continue;
    }
    if (candidates.some((entry) => entry.address === target)) {
      return target;
    }
    const match = candidates.find((entry) => {
      const mask = toNumber(entry.netmask);
      return (toNumber(entry.address) & mask) === (toNumber(target) & mask);
    });
    if (match) {
      return match.address;
    }
  }
  return candidates[0]?.address;
}

/** Replaces public IPv4 addresses anywhere in a text. Private ones stay, since they help diagnosis. */
export function hidePublicAddresses(text: string): string {
  return text
    .replace(/\b(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.([0-9a-f]{32})\.plex\.direct/gi, (match, a, b, c, d) =>
      (PRIVATE.test(`${a}.${b}.${c}.${d}`) ? match : 'remote-address.plex.direct'))
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (ip) => (PRIVATE.test(ip) || ip.split('.').some((p) => Number(p) > 255) ? ip : 'x.x.x.x'));
}

/** A server URL for a report: private addresses as they are, public ones hidden. */
export function maskAddress(url: string): string {
  const address = serverAddress(url);
  if (address && PRIVATE.test(address)) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${address}:${parsed.port || '32400'}`;
  }
  return 'remote address';
}
