/**
 * Renderizado WebGL2 (GPU) de polilíneas OMSI — instanced quads por segmento.
 * Pan/zoom solo actualiza uniforms; la geometría vive en VRAM.
 */

const UNIT_CORNERS = new Float32Array([
  0, -1, 1, -1, 1, 1,
  0, -1, 1, 1, 0, 1,
]);

const VERT_SRC = `#version 300 es
precision highp float;

in vec2 a_corner;
in vec2 i_p0;
in vec2 i_p1;
in vec4 i_color;
in float i_width;

uniform vec2 u_resolution;
uniform vec2 u_offset;
uniform float u_scale;
uniform float u_mirrorX;

out vec4 v_color;

vec2 worldToScreen(vec2 w) {
  float dx = (w.x - u_offset.x) * u_scale;
  float sx = u_mirrorX > 0.5
    ? (u_resolution.x * 0.5 - dx)
    : (u_resolution.x * 0.5 + dx);
  float sy = (w.y - u_offset.y) * u_scale + u_resolution.y * 0.5;
  return vec2(sx, sy);
}

void main() {
  vec2 s0 = worldToScreen(i_p0);
  vec2 s1 = worldToScreen(i_p1);
  vec2 delta = s1 - s0;
  float len = length(delta);
  vec2 dir = len > 0.0001 ? delta / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float t = a_corner.x;
  float side = a_corner.y;
  vec2 along = mix(s0, s1, t);
  vec2 pos = along + normal * side * i_width * 0.5;
  vec2 ndc = vec2(
    (pos.x / u_resolution.x) * 2.0 - 1.0,
    1.0 - (pos.y / u_resolution.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_color = i_color;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}
`;

const BUS_VERT = `#version 300 es
precision highp float;
in vec2 a_corner;
in vec2 i_center;
in vec4 i_color;
in float i_size;
uniform vec2 u_resolution;
uniform vec2 u_offset;
uniform float u_scale;
uniform float u_mirrorX;
out vec4 v_color;
vec2 worldToScreen(vec2 w) {
  float dx = (w.x - u_offset.x) * u_scale;
  float sx = u_mirrorX > 0.5 ? (u_resolution.x * 0.5 - dx) : (u_resolution.x * 0.5 + dx);
  float sy = (w.y - u_offset.y) * u_scale + u_resolution.y * 0.5;
  return vec2(sx, sy);
}
void main() {
  vec2 c = worldToScreen(i_center);
  vec2 pos = c + a_corner * i_size;
  vec2 ndc = vec2(
    (pos.x / u_resolution.x) * 2.0 - 1.0,
    1.0 - (pos.y / u_resolution.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_color = i_color;
}
`;

const BUS_CORNERS = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1,
]);

const FLOATS_PER_SEGMENT = 9;
const FLOATS_PER_BUS = 7;

export function hexToRgba(hex, alpha = 1) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    alpha,
  ];
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(msg || "Shader compile failed");
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "Program link failed");
  }
  return prog;
}

function railLinePoints(rail, spawnSegmentFn) {
  if (rail.points?.length >= 2) {
    return rail.freeStart ? spawnSegmentFn(rail) : rail.points;
  }
  if (rail.start && rail.end) return [rail.start, rail.end];
  return [];
}

function subsamplePoints(pts, maxPts = 24) {
  if (pts.length <= maxPts) return pts;
  const out = [pts[0]];
  const step = (pts.length - 1) / (maxPts - 1);
  for (let i = 1; i < maxPts - 1; i += 1) {
    out.push(pts[Math.round(i * step)]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function pushSegments(target, pts, rgba, widthPx, origin) {
  const ox = origin?.x ?? 0;
  const oz = origin?.z ?? 0;
  for (let i = 1; i < pts.length; i += 1) {
    target.push(
      pts[i - 1][0] - ox,
      pts[i - 1][2] - oz,
      pts[i][0] - ox,
      pts[i][2] - oz,
      rgba[0],
      rgba[1],
      rgba[2],
      rgba[3],
      widthPx,
    );
  }
}

/** Percentil en array ya ordenado. */
function percentile(sorted, pct) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * pct));
  return sorted[idx];
}

/**
 * Bounds sin outliers (mapas enormes con un riel lejano colapsan el zoom).
 * Si el span es razonable devuelve bounds tal cual.
 */
export function robustViewBounds(bounds, rails) {
  if (!bounds || !Number.isFinite(bounds.minX)) return bounds;
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const maxSpan = Math.max(spanX, spanZ);
  if (maxSpan < 45000 || !rails?.length) return bounds;

  const xs = [];
  const zs = [];
  const step = Math.max(1, Math.floor(rails.length / 12000));
  for (let i = 0; i < rails.length; i += step) {
    const rail = rails[i];
    const p = rail.points?.[0] || rail.start;
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[2])) {
      xs.push(p[0]);
      zs.push(p[2]);
    }
  }
  if (xs.length < 80) return bounds;

  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const minX = percentile(xs, 0.005);
  const maxX = percentile(xs, 0.995);
  const minZ = percentile(zs, 0.005);
  const maxZ = percentile(zs, 0.995);
  if (maxX - minX < 200 || maxZ - minZ < 200) return bounds;
  return { minX, maxX, minZ, maxZ };
}

export function computeMapOrigin(bounds) {
  if (!bounds) return { x: 0, z: 0 };
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
}

export async function buildGpuSegmentLayers(rails, {
  railTyp,
  freeStartHex,
  spawnSegmentFn,
  onProgress,
  chunkSize = 2000,
  origin,
}) {
  const base = [];
  const free = [];
  const total = rails.length;

  for (let i = 0; i < total; i += 1) {
    const rail = rails[i];
    if (rail.invis) continue;
    const pts = subsamplePoints(railLinePoints(rail, spawnSegmentFn));
    if (pts.length < 2) continue;

    const typ = railTyp[rail.typ] || railTyp[0];
    pushSegments(base, pts, hexToRgba(typ.stroke), 1.4, origin);

    if (rail.freeStart) {
      const spawnPts = subsamplePoints(spawnSegmentFn(rail));
      if (spawnPts.length >= 2) {
        pushSegments(free, spawnPts, hexToRgba(freeStartHex), 2.8, origin);
      }
    }

    if (i > 0 && i % chunkSize === 0) {
      onProgress?.(i, total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(total, total);
  return { base, free };
}

export function buildGpuOverlaySegments(railsById, {
  routeRails,
  selectedRailId,
  selectedHex,
  spawnSegmentFn,
  origin,
}) {
  const overlay = [];
  const done = new Set();

  for (const [rid, colors] of routeRails) {
    if (done.has(rid)) continue;
    const rail = railsById.get(rid);
    if (!rail) continue;
    done.add(rid);
    const pts = subsamplePoints(railLinePoints(rail, spawnSegmentFn));
    if (pts.length < 2) continue;
    pushSegments(overlay, pts, hexToRgba(colors[0]), 3.6, origin);
  }

  if (selectedRailId && !done.has(selectedRailId)) {
    const rail = railsById.get(selectedRailId);
    if (rail) {
      const pts = subsamplePoints(railLinePoints(rail, spawnSegmentFn));
      if (pts.length >= 2) {
        pushSegments(overlay, pts, hexToRgba(selectedHex), 4.5, origin);
      }
    }
  }
  return overlay;
}

export function buildGpuBusInstances(busstops, fillHex, strokeHex, origin) {
  const out = [];
  const fill = hexToRgba(fillHex);
  const stroke = hexToRgba(strokeHex);
  const ox = origin?.x ?? 0;
  const oz = origin?.z ?? 0;
  for (const stop of busstops) {
    out.push(stop.x - ox, stop.z - oz, fill[0], fill[1], fill[2], fill[3], 5);
    out.push(stop.x - ox, stop.z - oz, stroke[0], stroke[1], stroke[2], stroke[3], 6.5);
  }
  return out;
}

class InstanceLayer {
  constructor(gl, program, corners) {
    this.gl = gl;
    this.program = program;
    this.corners = corners;
    this.cornerBuf = gl.createBuffer();
    this.instanceBuf = gl.createBuffer();
    this.count = 0;
    this.floatsPerInstance = 0;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
  }

  setInstances(floats, floatsPerInstance) {
    const gl = this.gl;
    this.floatsPerInstance = floatsPerInstance;
    this.count = floats.length / floatsPerInstance;
    if (this.count <= 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const arr = floats instanceof Float32Array ? floats : new Float32Array(floats);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      throw new Error(`WebGL buffer upload failed (0x${err.toString(16)})`);
    }
  }

  draw(uniforms) {
    if (this.count <= 0) return 0;
    const gl = this.gl;
    gl.useProgram(this.program);

    gl.uniform2f(uniforms.resolution, uniforms.width, uniforms.height);
    gl.uniform2f(uniforms.offset, uniforms.offsetX, uniforms.offsetY);
    gl.uniform1f(uniforms.scaleLoc, uniforms.scale);
    gl.uniform1f(uniforms.mirrorXLoc, uniforms.mirrorX ? 1 : 0);

    const cornerLoc = gl.getAttribLocation(this.program, "a_corner");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const stride = this.floatsPerInstance * 4;

    if (this.floatsPerInstance === FLOATS_PER_SEGMENT) {
      this._bindInstance("i_p0", 2, 0);
      this._bindInstance("i_p1", 2, 8);
      this._bindInstance("i_color", 4, 16);
      this._bindInstance("i_width", 1, 32);
    } else {
      this._bindInstance("i_center", 2, 0);
      this._bindInstance("i_color", 4, 8);
      this._bindInstance("i_size", 1, 24);
    }

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    return this.count;
  }

  _bindInstance(name, size, offset) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(this.program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, this.floatsPerInstance * 4, offset);
    gl.vertexAttribDivisor(loc, 1);
  }
}

export class RailWebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.gl = null;
    this.lineProgram = null;
    this.busProgram = null;
    this.baseLayer = null;
    this.freeLayer = null;
    this.overlayLayer = null;
    this.busLayer = null;
    this.uniforms = {};
    this.width = 0;
    this.height = 0;
    this.baseSegments = 0;
    this.freeSegments = 0;
    this.origin = { x: 0, z: 0 };

    try {
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
        failIfMajorPerformanceCaveat: false,
      });
      if (!gl) return;

      this.gl = gl;
      this.lineProgram = createProgram(gl, VERT_SRC, FRAG_SRC);
      this.busProgram = createProgram(gl, BUS_VERT, FRAG_SRC);
      this.baseLayer = new InstanceLayer(gl, this.lineProgram, UNIT_CORNERS);
      this.freeLayer = new InstanceLayer(gl, this.lineProgram, UNIT_CORNERS);
      this.overlayLayer = new InstanceLayer(gl, this.lineProgram, UNIT_CORNERS);
      this.busLayer = new InstanceLayer(gl, this.busProgram, BUS_CORNERS);

      this.uniforms = {
        resolution: gl.getUniformLocation(this.lineProgram, "u_resolution"),
        offset: gl.getUniformLocation(this.lineProgram, "u_offset"),
        scale: gl.getUniformLocation(this.lineProgram, "u_scale"),
        mirrorX: gl.getUniformLocation(this.lineProgram, "u_mirrorX"),
      };
      this.busUniforms = {
        resolution: gl.getUniformLocation(this.busProgram, "u_resolution"),
        offset: gl.getUniformLocation(this.busProgram, "u_offset"),
        scale: gl.getUniformLocation(this.busProgram, "u_scale"),
        mirrorX: gl.getUniformLocation(this.busProgram, "u_mirrorX"),
      };

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.ok = true;
    } catch {
      this.ok = false;
    }
  }

  resize(width, height, dpr = 1) {
    if (!this.ok) return;
    this.width = Math.floor(width * dpr);
    this.height = Math.floor(height * dpr);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.gl.viewport(0, 0, this.width, this.height);
  }

  setBaseLayer(floats) {
    this.baseLayer.setInstances(floats, FLOATS_PER_SEGMENT);
    this.baseSegments = this.baseLayer.count;
  }

  setFreeLayer(floats) {
    this.freeLayer.setInstances(floats, FLOATS_PER_SEGMENT);
    this.freeSegments = this.freeLayer.count;
  }

  setOverlayLayer(floats) {
    this.overlayLayer.setInstances(floats, FLOATS_PER_SEGMENT);
  }

  setBusLayer(floats) {
    this.busLayer.setInstances(floats, FLOATS_PER_BUS);
  }

  setOrigin(origin) {
    this.origin = origin || { x: 0, z: 0 };
  }

  draw(view, { mirrorX, showAll, freeOnly, showBusstops }) {
    if (!this.ok) return 0;
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.071, 0.082, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const ox = this.origin?.x ?? 0;
    const oz = this.origin?.z ?? 0;
    const pack = {
      width: this.width,
      height: this.height,
      offsetX: view.offsetX - ox,
      offsetY: view.offsetY - oz,
      scale: view.scale,
      mirrorX,
      resolution: this.uniforms.resolution,
      offset: this.uniforms.offset,
      scaleLoc: this.uniforms.scale,
      mirrorXLoc: this.uniforms.mirrorX,
    };

    let drawn = 0;
    if (showAll && !freeOnly) drawn += this.baseLayer.draw(pack);
    if ((showAll && !freeOnly) || freeOnly) drawn += this.freeLayer.draw(pack);
    drawn += this.overlayLayer.draw(pack);

    if (showBusstops && this.busLayer.count > 0) {
      gl.useProgram(this.busProgram);
      gl.uniform2f(this.busUniforms.resolution, pack.width, pack.height);
      gl.uniform2f(this.busUniforms.offset, pack.offsetX, pack.offsetY);
      gl.uniform1f(this.busUniforms.scale, pack.scale);
      gl.uniform1f(this.busUniforms.mirrorX, mirrorX ? 1 : 0);
      const busPack = {
        width: pack.width,
        height: pack.height,
        offsetX: pack.offsetX,
        offsetY: pack.offsetY,
        scale: pack.scale,
        mirrorX,
        resolution: this.busUniforms.resolution,
        offset: this.busUniforms.offset,
        scaleLoc: this.busUniforms.scale,
        mirrorXLoc: this.busUniforms.mirrorX,
      };
      this.busLayer.draw(busPack);
    }
    return drawn;
  }
}

export function isWebGL2Available() {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}
