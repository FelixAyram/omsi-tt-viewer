/** Geometría OMSI 2 — splines (.sli) y paths .sco (alineado con OmsiScoPathGeometry.cs). */

const DEG = Math.PI / 180;
const SCO_STRAIGHT_EPS = 0.001;

export function dirFromRotation(rotDeg) {
  const r = rotDeg * DEG;
  return { x: Math.sin(r), z: Math.cos(r) };
}

export function normalizeDir(v) {
  const len = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / len, z: v.z / len };
}

export function perpOffset(dir, lateral) {
  const n = normalizeDir(dir);
  // Signo alineado con OMSI/Unity (SampleSplineAttachmentFrame local X).
  return { x: n.z * lateral, z: -n.x * lateral };
}

export function rotateY(v, rotDeg) {
  const r = rotDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c + v.z * s, z: -v.x * s + v.z * c };
}

/** Posición local en spline a distancia `dist` desde el inicio. */
export function splineLocalAt(sx, sy, rotDeg, radius, dist, startHeight = 0) {
  const rotRad = rotDeg * DEG;
  let xf;
  let yf;
  let rotFinal;

  if (!radius || Math.abs(radius) < 1e-6) {
    xf = sx + dist * Math.sin(rotRad);
    yf = sy + dist * Math.cos(rotRad);
    rotFinal = rotDeg % 360;
  } else {
    const theta = dist / radius;
    const xTemp = radius * (1 - Math.cos(theta));
    const yTemp = radius * Math.sin(theta);
    xf = sx + xTemp * Math.cos(rotRad) + yTemp * Math.sin(rotRad);
    yf = sy - xTemp * Math.sin(rotRad) + yTemp * Math.cos(rotRad);
    rotFinal = (rotDeg + (theta * 180) / Math.PI) % 360;
  }

  return { x: xf, y: yf, z: startHeight, rot: rotFinal };
}

export function segmentCount(length, radius) {
  const len = Math.max(length, 0.01);
  if (!radius || Math.abs(radius) < 1e-6) {
    return Math.min(64, Math.max(2, Math.ceil(len / 12)));
  }
  const arc = len / Math.abs(radius);
  return Math.min(96, Math.max(8, Math.ceil(arc / (Math.PI / 20))));
}

/** Polilínea mundial de un carril sobre spline (.sli path). */
export function sampleSplineRail(
  spline,
  tileOrigin,
  { lateral = 0, height = 0, segments = null } = {},
) {
  const n = segments ?? segmentCount(spline.largo, spline.radius);
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const d = (spline.largo * i) / n;
    const local = splineLocalAt(
      spline.x,
      spline.y,
      spline.rotation,
      spline.radius,
      d,
      spline.z,
    );
    const dir = dirFromRotation(local.rot);
    const off = perpOffset(dir, lateral);
    const wx = tileOrigin.x + local.x + off.x;
    const wz = tileOrigin.z + local.y + off.z;
    const wy = local.z + height;
    pts.push([wx, wy, wz]);
  }
  return pts;
}

function isNearStraightSco(path) {
  return !path.radius || Math.abs(path.radius) < SCO_STRAIGHT_EPS;
}

/** Algunos .sco guardan el largo en grados de arco, no metros (Unity IsLengthInDegrees). */
export function isScoLengthInDegrees(path) {
  if (isNearStraightSco(path)) return false;
  const absLen = Math.abs(path.length);
  const rAbs = Math.abs(path.radius);
  if (absLen < 0.001 || rAbs < SCO_STRAIGHT_EPS || absLen > 360) return false;
  return absLen / rAbs > Math.PI * 1.05;
}

export function estimateScoSegmentLengthMeters(path) {
  const length = Math.abs(path.length) || 0.01;
  if (!isScoLengthInDegrees(path)) return length;
  return Math.abs(path.radius) * Math.abs(path.length) * DEG;
}

function scoHeightDeltaAt(path, along, length) {
  const p1 = Math.max(-500, Math.min(500, path.gradStart ?? 0)) / 100;
  const p2 = Math.max(-500, Math.min(500, path.gradEnd ?? 0)) / 100;
  if (Math.abs(p1) < 1e-9 && Math.abs(p2) < 1e-9) return 0;
  const acc = (p2 - p1) / Math.max(0.001, length);
  return p1 * along + 0.5 * acc * along * along;
}

/** Muestra en coords OMSI del SCO (X, Y plano, Z altura) — port de SampleAttachmentFrame. */
export function sampleScoAttachmentFrame(path, t, lateralOffset = 0) {
  const clampT = Math.max(0, Math.min(1, t));
  const length = estimateScoSegmentLengthMeters(path);
  const along = length * clampT;
  const tRel = length > 0.001 ? along / length : 0;

  const radius = path.radius;
  const isRecto = isNearStraightSco(path);
  const rAbs = Math.max(SCO_STRAIGHT_EPS, Math.abs(radius));
  const dir = radius >= 0 ? 1 : -1;
  const angTotal = isRecto ? 0 : length / rAbs;

  let localX;
  let localZ;
  if (isRecto) {
    localX = lateralOffset;
    localZ = along;
  } else {
    const ang = tRel * angTotal;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const lat = lateralOffset;
    const rCenter = rAbs - lat * dir;
    localX = (rAbs - cosA * rCenter) * dir;
    localZ = sinA * rCenter;
  }

  const hdgRad = path.angle * DEG;
  const sinH = Math.sin(hdgRad);
  const cosH = Math.cos(hdgRad);
  const omsiX = path.sx + sinH * localZ + cosH * localX;
  const omsiY = path.sy + cosH * localZ - sinH * localX;
  const omsiZ = path.sz + scoHeightDeltaAt(path, along, length);
  return { omsiX, omsiY, omsiZ };
}

/** OMSI (X, Y, Z) → visor/Unity local (X, altura, Z). */
export function omsiScoToViewerLocal(omsiX, omsiY, omsiZ) {
  return { x: omsiX, y: omsiZ, z: omsiY };
}

export function computeScoSampleCount(path, targetIntervalMeters = 2) {
  const length = estimateScoSegmentLengthMeters(path);
  if (length < 0.001) return 2;
  const intervalSamples = Math.max(2, Math.ceil(length / Math.max(0.5, targetIntervalMeters)) + 1);
  if (isNearStraightSco(path)) {
    return Math.min(64, intervalSamples);
  }
  const angTotal = length / Math.abs(path.radius);
  const omsiSamples = Math.max(2, Math.ceil((angTotal * 180) / Math.PI / 0.5) + 1);
  return Math.min(96, Math.max(omsiSamples, intervalSamples));
}

/** Polilínea mundial de path .sco: local SCO → rotación objeto → tile (como Unity). */
export function sampleScoRail(obj, scoPath, tileOrigin, segments = null) {
  const n = segments ?? computeScoSampleCount(scoPath);
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const t = n <= 0 ? 0 : i / n;
    const { omsiX, omsiY, omsiZ } = sampleScoAttachmentFrame(scoPath, t);
    const local = omsiScoToViewerLocal(omsiX, omsiY, omsiZ);
    const p = rotateY({ x: local.x, z: local.z }, obj.rotation);
    pts.push([
      tileOrigin.x + obj.x + p.x,
      obj.z + local.y,
      tileOrigin.z + obj.y + p.z,
    ]);
  }
  return pts;
}

export function expandBounds(bounds, x, z) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

export function distPointPolyline(px, pz, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const x1 = points[i - 1][0];
    const z1 = points[i - 1][2];
    const x2 = points[i][0];
    const z2 = points[i][2];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-9) {
      t = ((px - x1) * dx + (pz - z1) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const qx = x1 + t * dx;
    const qz = z1 + t * dz;
    best = Math.min(best, Math.hypot(px - qx, pz - qz));
  }
  return best;
}
