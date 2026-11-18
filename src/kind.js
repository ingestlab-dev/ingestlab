
export function sniffKind(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length > 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
  if (u8.length > 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return 'video/mp4';
  if (u8.length > 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'video/webm';
  if (u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8.length > 12 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8.length > 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  if (u8.length > 12 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  return 'unknown';
}
