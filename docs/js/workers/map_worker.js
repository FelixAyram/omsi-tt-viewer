/**
 * Web Worker: parseo .sli/.sco y generación de rieles por lotes.
 */
import { buildSplineRails, buildScoRails, parseSliPaths, parseSliFile, parseScoPaths } from "../rail_builder.js?v=40";

self.onmessage = (ev) => {
  const { id, type, items, text, key } = ev.data ?? {};
  try {
    let result;
    if (type === "spline") {
      result = buildSplineRails(items);
    } else if (type === "sco") {
      result = buildScoRails(items);
    } else if (type === "parseSli") {
      const { paths, onlyEditor } = parseSliFile(text);
      result = { key, pathsEntries: [...paths.entries()], onlyEditor };
    } else if (type === "parseSco") {
      const paths = parseScoPaths(text);
      result = { key, pathsEntries: [...paths.entries()] };
    } else {
      throw new Error(`Unknown worker task: ${type}`);
    }
    self.postMessage({ id, ...result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
