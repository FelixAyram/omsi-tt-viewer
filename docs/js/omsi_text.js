/** Decodifica textos OMSI (.map, global.cfg suelen ser UTF-16 LE con BOM). */
export async function readOmsiText(file) {
  const buf = await file.arrayBuffer();
  return decodeOmsiBytes(buf);
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

/**
 * Splines (.sli) y assets similares: ANSI/ASCII de un byte en OMSI.
 * No usar UTF-8 ni UTF-16 (rompe [path] y secciones).
 */
export async function readOmsiAnsiText(file) {
  const buf = await file.arrayBuffer();
  return decodeOmsiAnsiBytes(buf);
}

export function decodeOmsiAnsiBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let start = 0;
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) start = 2;
  else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) start = 2;
  return new TextDecoder("latin1").decode(u8.subarray(start));
}

/** @deprecated alias */
export const readOmsiSliText = readOmsiAnsiText;
