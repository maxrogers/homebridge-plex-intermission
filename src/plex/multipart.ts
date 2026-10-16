/**
 * Extracts the JSON `payload` field from a Plex webhook body. Plex sends multipart/form-data with
 * the payload and, for some events, a thumbnail image. A plain JSON body is accepted too.
 */
export function extractWebhookPayload(body: Buffer, contentType: string | undefined): unknown {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (!boundary) {
    return parseJson(body.toString('utf8'));
  }
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) {
      break;
    }
    const part = body.subarray(start + delimiter.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1 && /name="payload"/i.test(part.subarray(0, headerEnd).toString('utf8'))) {
      return parseJson(part.subarray(headerEnd + 4).toString('utf8').replace(/\r\n$/, ''));
    }
    start = next;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
