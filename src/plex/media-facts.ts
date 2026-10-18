import { toBoolean, toNumber } from './convert.js';
import type { PlexMedia, PlexMetadata } from './types.js';

/**
 * What media conditions can test, read from the library item (not the playback session), so the
 * values describe the file and never change mid-play when Plex starts or stops transcoding.
 */
export interface MediaFacts {
  /** Width divided by height, for example 2.39. */
  aspectRatio?: number;
  resolution?: Resolution;
  dynamicRange?: DynamicRange;
  contentRating?: string;
  /** Labels on the item; for an episode, also the show's. */
  labels: string[];
}

export type Resolution = '4k' | 'hd' | 'sd';
export type DynamicRange = 'dv' | 'hdr' | 'sdr';

/** Pictures at least this wide count as wide (2.39:1 and 2.20:1 do; 1.85:1 and 16:9 don't). */
export const WIDE_ASPECT = 2.2;

function resolution(value: string | undefined): Resolution | undefined {
  if (!value) {
    return undefined;
  }
  const v = value.toLowerCase();
  if (v === '4k' || v === '2160' || v === '8k') {
    return '4k';
  }
  if (v === '1080' || v === '720') {
    return 'hd';
  }
  return 'sd';
}

function dynamicRange(media: PlexMedia | undefined): DynamicRange | undefined {
  const video = media?.Part?.flatMap((part) => part.Stream ?? []).find((stream) => Number(stream.streamType) === 1);
  if (!video) {
    return undefined;
  }
  if (toBoolean(video.DOVIPresent)) {
    return 'dv';
  }
  // PQ (HDR10, HDR10+) and HLG.
  return video.colorTrc === 'smpte2084' || video.colorTrc === 'arib-std-b67' ? 'hdr' : 'sdr';
}

const tags = (items: { tag?: string }[] | undefined) => (items ?? []).flatMap((item) => (item.tag ? [item.tag] : []));

/** Facts from `/library/metadata/{id}`, and the show's metadata for an episode. */
export function factsFromMetadata(item: PlexMetadata, show?: PlexMetadata): MediaFacts {
  const media = item.Media?.[0];
  return {
    aspectRatio: toNumber(media?.aspectRatio),
    resolution: resolution(media?.videoResolution),
    dynamicRange: dynamicRange(media),
    contentRating: item.contentRating ?? show?.contentRating,
    labels: [...new Set([...tags(item.Label), ...tags(show?.Label)])],
  };
}
