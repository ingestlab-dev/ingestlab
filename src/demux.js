// Demux progressive MP4 and WebM for WebCodecs.

import { sniffKind } from './kind.js';
export { sniffKind };

function u32(b, o) {
  return (b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3]) >>> 0;
}
function i32(b, o) {
  return u32(b, o) | 0;
}
function type4(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function u64(b, o) {
  return u32(b, o) * 4294967296 + u32(b, o + 4);
}
const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const DBG = typeof process !== 'undefined' && process.env && process.env.DEMUX_DEBUG;
const dlog = (...a) => { if (DBG) console.error('[demux]', ...a); };

function walkBoxes(b, start, end, cb) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = type4(b, o + 4);
    let head = 8;
    if (size === 1) {
      size = u64(b, o + 8);
      head = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < head || o + size > end) break;
    cb(type, o + head, o + size, o, head);
    o += size;
  }
}

function findBox(b, start, end, path) {
  let s = start;
  let e = end;
  let found = null;
  for (let i = 0; i < path.length; i++) {
    found = null;
    walkBoxes(b, s, e, (type, ps, pe) => {
      if (!found && type === path[i]) found = [ps, pe];
    });
    if (!found) return null;
    [s, e] = found;
  }
  return found;
}

/** Collect all boxes matching a path (e.g. every trak under moov). */
function collectBoxes(b, start, end, path) {
  let ranges = [[start, end]];
  for (let i = 0; i < path.length; i++) {
    const next = [];
    for (const [s, e] of ranges) {
      walkBoxes(b, s, e, (type, ps, pe) => {
        if (type === path[i]) next.push([ps, pe]);
      });
    }
    ranges = next;
    if (!ranges.length) return [];
  }
  return ranges;
}

function childBox(b, start, end, type) {
  let found = null;
  walkBoxes(b, start, end, (t, ps, pe) => {
    if (!found && t === type) found = [ps, pe];
  });
  return found;
}

const VIDEO_SAMPLES = { avc1: 1, avc3: 1, hvc1: 1, hev1: 1, av01: 1, vp09: 1 };

function demuxMP4(u8) {
  let moov = null;
  walkBoxes(u8, 0, u8.length, (type, ps, pe) => {
    if (type === 'moov') moov = [ps, pe];
  });
  if (!moov) throw new Error('ingestlab demux: MP4 has no moov box (fragmented MP4 not supported yet)');

  for (const [ts, te] of collectBoxes(u8, moov[0], moov[1], ['trak'])) {
    dlog('trak', ts, te);
    const hdlr = findBox(u8, ts, te, ['mdia', 'hdlr']);
    dlog('hdlr:', hdlr && hdlr.map((v) => v), 'handler:', hdlr && type4(u8, hdlr[0] + 8));
    if (!hdlr) continue;
    const handler = type4(u8, hdlr[0] + 8);
    if (handler !== 'vide') continue;

    const mdhd = findBox(u8, ts, te, ['mdia', 'mdhd']);
    if (!mdhd) continue;
    const version = u8[mdhd[0]];
    const timescale = version === 1 ? u32(u8, mdhd[0] + 20) : u32(u8, mdhd[0] + 12);

    const stbl = findBox(u8, ts, te, ['mdia', 'minf', 'stbl']);
    if (!stbl) continue;

    const stsd = childBox(u8, stbl[0], stbl[1], 'stsd');
    if (!stsd) continue;
    const entryCount = u32(u8, stsd[0] + 4);
    if (entryCount < 1) continue;
    const entryStart = stsd[0] + 8;
    const entrySize = u32(u8, entryStart);
    const entryEnd = entryStart + entrySize;
    const format = type4(u8, entryStart + 4);
    if (!VIDEO_SAMPLES[format]) continue;

    let width = 0;
    let height = 0;
    let codec = null;
    let description = null;
    {
      width = (u8[entryStart + 8 + 24] << 8) | u8[entryStart + 8 + 25];
      height = (u8[entryStart + 8 + 26] << 8) | u8[entryStart + 8 + 27];
      const children = [entryStart + 8 + 78, entryEnd];
      if (format === 'avc1' || format === 'avc3') {
        const avcC = childBox(u8, children[0], children[1], 'avcC');
        if (!avcC) throw new Error('ingestlab demux: avc1 without avcC');
        const p = u8[avcC[0] + 1];
        const c = u8[avcC[0] + 2];
        const l = u8[avcC[0] + 3];
        codec = `avc1.${hex2(p)}${hex2(c)}${hex2(l)}`;
        description = u8.slice(avcC[0], avcC[1]);
      } else if (format === 'hvc1' || format === 'hev1') {
        const hvcC = childBox(u8, children[0], children[1], 'hvcC');
        codec = 'hvc1.1.6.L93.B0'; // The HEVC profile is in hvcC.
        description = hvcC ? u8.slice(hvcC[0], hvcC[1]) : null;
      } else if (format === 'av01') {
        const av1C = childBox(u8, children[0], children[1], 'av1C');
        if (!av1C) throw new Error('ingestlab demux: av01 without av1C');
        const b0 = u8[av1C[0]];
        const b1 = u8[av1C[0] + 1];
        const profile = b0 & 0x1f;
        const level = ((b0 >> 5) | ((b1 >> 7) << 3)) & 0x1f;
        const tier = (b1 >> 6) & 1 ? 'H' : 'M';
        const bitdepth = (b1 >> 3) & 1 ? 12 : 8;
        codec = `av01.${hex2(profile)}.${String(level).padStart(2, '0')}${tier}.${String(bitdepth).padStart(2, '0')}`;
        description = u8.slice(av1C[0], av1C[1]);
      } else if (format === 'vp09') {
        const vpcC = childBox(u8, children[0], children[1], 'vpcC');
        const p = vpcC ? u8[vpcC[0]] : 0;
        const l = vpcC ? u8[vpcC[0] + 1] : 16;
        const d = vpcC ? (u8[vpcC[0] + 3] >> 4) & 0xf : 8;
        codec = `vp09.${hex2(p)}.${hex2(l)}.${hex2(d)}`;
        description = vpcC ? u8.slice(vpcC[0], vpcC[1]) : null;
      }
    }

    const stsz = childBox(u8, stbl[0], stbl[1], 'stsz');
    const stsc = childBox(u8, stbl[0], stbl[1], 'stsc');
    const stco = childBox(u8, stbl[0], stbl[1], 'stco');
    const co64 = childBox(u8, stbl[0], stbl[1], 'co64');
    const stts = childBox(u8, stbl[0], stbl[1], 'stts');
    const ctts = childBox(u8, stbl[0], stbl[1], 'ctts');
    const stss = childBox(u8, stbl[0], stbl[1], 'stss');
    dlog('stbl:', stbl, 'stsd fmt:', format, 'stsz:', !!stsz, 'stsc:', !!stsc,
      'stco:', !!stco, 'co64:', !!co64, 'stts:', !!stts, 'stss:', !!stss);
    if (!stsz || !stsc || !(stco || co64) || !stts) {
      throw new Error('ingestlab demux: incomplete MP4 sample tables');
    }

    const sampleCount = u32(u8, stsz[0] + 8);
    const uniformSize = u32(u8, stsz[0] + 4);
    dlog('sampleCount:', sampleCount, 'uniformSize:', uniformSize);
    const sizes = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      sizes[i] = uniformSize || u32(u8, stsz[0] + 12 + i * 4);
    }

    const nChunks = u32(u8, (stco || co64)[0] + 4);
    dlog('nChunks:', nChunks);
    const chunkOffsets = new Array(nChunks);
    for (let i = 0; i < nChunks; i++) {
      chunkOffsets[i] = stco ? u32(u8, stco[0] + 8 + i * 4) : u64(u8, co64[0] + 8 + i * 8);
    }

    // chunk -> samples-per-chunk (stsc entries are ranges)
    const stscEntries = [];
    const nEntries = u32(u8, stsc[0] + 4);
    for (let i = 0; i < nEntries; i++) {
      stscEntries.push([u32(u8, stsc[0] + 8 + i * 12), u32(u8, stsc[0] + 12 + i * 12)]);
    }
    const spcFor = (chunk1based) => {
      let spc = stscEntries[0][1];
      for (const [first, s] of stscEntries) {
        if (first <= chunk1based) spc = s;
        else break;
      }
      return spc;
    };

    const ttsEntries = [];
    const nTts = u32(u8, stts[0] + 4);
    for (let i = 0; i < nTts; i++) {
      ttsEntries.push([u32(u8, stts[0] + 8 + i * 8), u32(u8, stts[0] + 12 + i * 8)]);
    }
    // Keep packet order for decoding and pass presentation timestamps.
    const composition = [];
    if (ctts) {
      const [start, end] = ctts;
      if (end - start < 8) throw new Error('ingestlab demux: invalid MP4 composition offsets');
      const version = u8[start], count = u32(u8, start + 4);
      if (version > 1 || count > Math.floor((end - start - 8) / 8)) {
        throw new Error('ingestlab demux: invalid MP4 composition offsets');
      }
      let covered = 0;
      for (let i = 0; i < count; i++) {
        const pos = start + 8 + i * 8, run = u32(u8, pos), raw = u32(u8, pos + 4);
        composition.push([run, version === 1 ? raw | 0 : raw]);
        covered += run;
      }
      if (covered !== sampleCount || composition.some(([run]) => !run)) {
        throw new Error('ingestlab demux: MP4 composition offsets do not match sample count');
      }
    }
    const keySamples = stss ? u32(u8, stss[0] + 4) : null;
    const keySet = new Set();
    if (stss) {
      for (let i = 0; i < keySamples; i++) keySet.add(u32(u8, stss[0] + 8 + i * 4));
    }

    const chunks = [];
    let sampleIdx = 0;
    let ttsIdx = 0;
    let ttsRemaining = ttsEntries.length ? ttsEntries[0][0] : 0;
    let tsTicks = 0;
    let compositionIndex = 0, compositionRemaining = composition[0]?.[0] ?? 0;
    let firstPts = Infinity, lastEnd = -Infinity;
    for (let c = 0; c < nChunks && sampleIdx < sampleCount; c++) {
      let off = chunkOffsets[c];
      const spc = spcFor(c + 1);
      for (let s = 0; s < spc && sampleIdx < sampleCount; s++, sampleIdx++) {
        const size = sizes[sampleIdx];
        if (ttsRemaining === 0 && ttsIdx + 1 < ttsEntries.length) {
          ttsIdx++;
          ttsRemaining = ttsEntries[ttsIdx][0];
        }
        const delta = ttsRemaining > 0 ? ttsEntries[ttsIdx][1] : 0;
        const pts = tsTicks + (composition[compositionIndex]?.[1] ?? 0);
        const timestampUs = Math.round((pts * 1e6) / timescale);
        const durationUs = Math.round((delta * 1e6) / timescale);
        firstPts = Math.min(firstPts, pts);
        lastEnd = Math.max(lastEnd, pts + delta);
        chunks.push({
          type: stss ? (keySet.has(sampleIdx + 1) ? 'key' : 'delta') : 'key',
          timestampUs,
          durationUs,
          data: u8.slice(off, off + size),
        });
        tsTicks += delta;
        if (compositionRemaining && --compositionRemaining === 0) {
          compositionIndex++;
          compositionRemaining = composition[compositionIndex]?.[0] ?? 0;
        }
        if (ttsRemaining > 0) ttsRemaining--;
        off += size;
      }
    }

    return {
      container: 'mp4',
      codec,
      description,
      codedWidth: width,
      codedHeight: height,
      durationUs: chunks.length ? Math.round((lastEnd - firstPts) * 1e6 / timescale) : 0,
      chunks,
    };
  }
  throw new Error('ingestlab demux: no supported video track in MP4');
}

const WEBM_CODECS = { V_VP8: 'vp8', V_VP9: 'vp09.00.10.08', V_AV1: 'av01.0.04M.08' };

// The leading zero bits determine the EBML integer width.
function vintWidth(first) {
  const w = Math.clz32(first) - 23;
  if (w < 1 || w > 8) throw new Error('ingestlab demux: bad EBML vint');
  return w;
}

function readVintId(b, o) {
  // EBML element IDs retain their marker bits.
  const first = b[o];
  if (!first) throw new Error('ingestlab demux: bad EBML id');
  const len = Math.min(4, vintWidth(first));
  let v = first;
  for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
  return [v >>> 0, len];
}

function readVintSize(b, o) {
  const first = b[o];
  if (!first) throw new Error('ingestlab demux: bad EBML size');
  if (first === 0xff) return [Infinity, 1]; // Unknown EBML size.
  const len = vintWidth(first);
  let v = first & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
  return [v, len];
}

function demuxWebM(u8) {
  let timestampScaleNs = 1e6;
  let trackNumber = null;
  let codecId = null;
  let width = 0;
  let height = 0;
  const chunks = [];

  function parseTracks(s, e) {
    walkEbml(s, e, (id, ps, pe) => {
      if (id === 0xae) parseTrackEntry(ps, pe); // TrackEntry
    });
  }

  function parseTrackEntry(s, e) {
    let type = 0;
    let trackNo = null;
    dlog('parseTrackEntry', s, e);
    walkEbml(s, e, (id, ps, pe) => {
      if (id === 0xd7) trackNo = readUint(ps, pe); // TrackNumber (plain big-endian uint)
      else if (id === 0x83) type = readUint(ps, pe); // TrackType
      else if (id === 0x86) codecId = readString(ps, pe); // CodecID
      else if (id === 0xe0) {
        walkEbml(ps, pe, (id2, ps2, pe2) => {
          if (id2 === 0xb0) width = readUint(ps2, pe2); // PixelWidth
          else if (id2 === 0xba) height = readUint(ps2, pe2); // PixelHeight
        });
      }
    });
    if (type !== 1) {
      trackNo = null;
      codecId = null;
    }
    trackNumber = trackNo;
  }

  function walkEbml(s, e, cb) {
    let o = s;
    while (o < e) {
      const [id, idLen] = readVintId(u8, o);
      const [size, sizeLen] = readVintSize(u8, o + idLen);
      const ps = o + idLen + sizeLen;
      const pe = size === Infinity ? e : Math.min(ps + size, e);
      cb(id, ps, pe);
      if (size === Infinity) return;
      o = pe;
    }
  }

  function readUint(s, e) {
    let v = 0;
    for (let o = s; o < e; o++) v = v * 256 + u8[o];
    return v;
  }
  function readString(s, e) {
    let out = '';
    for (let o = s; o < e; o++) out += String.fromCharCode(u8[o]);
    return out;
  }

  walkEbml(0, u8.length, (id, ps, pe) => {
    dlog('top id=0x' + id.toString(16), 'range', ps, pe);
    if (id === 0x18538067) parseSegment(ps, pe); // Segment
  });

  function parseSegment(s, e) {
    dlog('parseSegment', s, e);
    walkEbml(s, e, (id, ps, pe) => {
      dlog('seg child id=0x' + id.toString(16), ps, pe);
      if (id === 0x1654ae6b) parseTracks(ps, pe); // Tracks
      else if (id === 0x1549a966) parseInfo(ps, pe); // Info
      else if (id === 0x1f43b675) parseCluster(ps, pe); // Cluster
    });
  }

  function parseInfo(s, e) {
    walkEbml(s, e, (id, ps, pe) => {
      if (id === 0x2ad7b1) timestampScaleNs = readUint(ps, pe) || 1e6; // TimestampScale
    });
  }

  function parseCluster(s, e) {
    dlog('parseCluster', s, e);
    let clusterBaseTicks = 0;
    walkEbml(s, e, (id, ps, pe) => {
      if (id === 0xe7) clusterBaseTicks = readUint(ps, pe); // Timecode
      else if (id === 0xa3) parseSimpleBlock(ps, pe, clusterBaseTicks); // SimpleBlock
    });
  }

  function parseSimpleBlock(s, e, clusterBaseTicks) {
    // Block header: track number, signed timecode, flags.
    const [trackNo, tnLen] = readVintSize(u8, s); // size-style VINT: marker stripped
    const relTicks = (u8[s + tnLen] << 8) | u8[s + tnLen + 1];
    const timeNs = (clusterBaseTicks + relTicks) * timestampScaleNs;
    const flags = u8[s + tnLen + 2];
    const keyframe = !!(flags & 0x80);
    const lacing = (flags >> 1) & 0x3;
    let o = s + tnLen + 3;
    const sizes = [];
    if (lacing === 0) {
      sizes.push(e - o);
    } else {
      const laceCount = u8[o++] + 1;
      if (lacing === 1) {
        // Xiph
        let total = 0;
        for (let i = 0; i < laceCount - 1; i++) {
          let sz = 0;
          let v;
          do {
            v = u8[o++];
            sz += v;
          } while (v === 255);
          sizes.push(sz);
          total += sz;
        }
        sizes.push(e - o - total);
      } else if (lacing === 2) {
        // Fixed-size lacing.
        const sz = Math.floor((e - o) / laceCount);
        for (let i = 0; i < laceCount; i++) sizes.push(sz);
      } else {
        throw new Error('ingestlab demux: EBML lacing not supported');
      }
    }
    if (String(trackNo) !== String(trackNumber)) return;
    dlog('block ts=', timeNs / 1000, 'key=', keyframe, 'lace=', lacing, 'sizes=', sizes.length, 'track=', trackNo);
    for (const sz of sizes) {
      chunks.push({
        type: keyframe ? 'key' : 'delta',
        timestampUs: Math.round(timeNs / 1000),
        durationUs: 0,
        data: u8.slice(o, o + sz),
      });
      o += sz;
    }
  }

  dlog('codecId:', codecId, 'trackNumber:', trackNumber, 'dims:', width, height);
  if (!codecId || trackNumber === null) {
    throw new Error('ingestlab demux: no supported video track in WebM (need V_VP8/V_VP9/V_AV1)');
  }
  // Distribute timestamps if the cluster gives every frame the same time.
  const codec = WEBM_CODECS[codecId];
  if (!codec) throw new Error(`ingestlab demux: unsupported WebM codec ${codecId}`);
  let durationUs = 0;
  if (chunks.length) {
    let prev = chunks[0].timestampUs;
    for (const c of chunks) {
      if (c.timestampUs < prev) c.timestampUs = prev;
      prev = c.timestampUs;
    }
    const frame = durationEstimate(chunks);
    durationUs = chunks[chunks.length - 1].timestampUs + frame;
  }
  return {
    container: 'webm',
    codec,
    description: undefined,
    codedWidth: width,
    codedHeight: height,
    durationUs,
    chunks,
  };
}

function durationEstimate(chunks) {
  // median positive gap -> sane per-frame duration for VP8/VP9 webm
  const gaps = [];
  for (let i = 1; i < chunks.length; i++) {
    const g = chunks[i].timestampUs - chunks[i - 1].timestampUs;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 33333;
}

export function demuxVideo(bytes) {
  const kind = sniffKind(bytes);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (kind === 'video/mp4') return demuxMP4(u8);
  if (kind === 'video/webm') return demuxWebM(u8);
  throw new Error(`ingestlab demux: unsupported container "${kind}" (use MP4 or WebM)`);
}
