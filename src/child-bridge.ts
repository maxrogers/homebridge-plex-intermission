import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Homebridge's own child bridge category: Bridge. */
const BRIDGE_CATEGORY = 2;

export interface BridgePairing {
  /** False until the child bridge has started once (Homebridge restarted). */
  published: boolean;
  paired: boolean;
  /** Pairing code as the Home app shows it, for example 031-45-154. */
  pincode?: string;
  /** X-HM:// URI for the QR code. */
  setupURI?: string;
}

/**
 * The HomeKit setup URI, computed exactly as HAP-NodeJS does (Accessory.setupURI), so the QR code
 * Intermission shows is the one the Home app expects.
 */
export function setupURI(pincode: string, category: number, setupID: string): string {
  const buffer = Buffer.alloc(8);
  let low = parseInt(pincode.replace(/-/g, ''), 10);
  const high = category >> 1;
  low |= 1 << 28; // Supports IP.
  buffer.writeUInt32BE(low >>> 0, 4);
  if (category & 1) {
    buffer[4] = buffer[4]! | (1 << 7);
  }
  buffer.writeUInt32BE(high, 0);
  let payload = (buffer.readUInt32BE(4) + buffer.readUInt32BE(0) * 0x100000000).toString(36).toUpperCase();
  while (payload.length < 9) {
    payload = `0${payload}`;
  }
  return `X-HM://${payload}${setupID}`;
}

/**
 * Pairing details of Intermission's child bridge, from the file HAP-NodeJS keeps for it in
 * Homebridge's `persist` folder. The Homebridge UI shows the same code on its own pages.
 */
export async function bridgePairing(homebridgeStoragePath: string, username: string): Promise<BridgePairing> {
  const file = join(homebridgeStoragePath, 'persist', `AccessoryInfo.${username.replace(/:/g, '').toUpperCase()}.json`);
  let saved: { pincode?: string; setupID?: string; category?: number; pairedClients?: Record<string, unknown> };
  try {
    saved = JSON.parse(await readFile(file, 'utf8')) as typeof saved;
  } catch {
    return { published: false, paired: false };
  }
  const paired = Object.keys(saved.pairedClients ?? {}).length > 0;
  if (!saved.pincode || !saved.setupID) {
    return { published: true, paired };
  }
  return { published: true, paired, pincode: saved.pincode, setupURI: setupURI(saved.pincode, saved.category ?? BRIDGE_CATEGORY, saved.setupID) };
}
