/** Decodifica textos OMSI (.map, global.cfg suelen ser UTF-16 LE con BOM). */
export async function readOmsiText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function decodeOmsiBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(u8);
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(u8);
  }
  return new TextDecoder("utf-8").decode(u8);
}