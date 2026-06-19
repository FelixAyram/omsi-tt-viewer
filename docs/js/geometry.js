/** Geometría OMSI 2 — splines y paths .sco con radio (port de spline_geometry.py). */

const DEG = Math.PI / 180;

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
  return { x: -n.z * lateral, z: n.x * lateral };
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

/** Polilínea mundial de path .sco (local → rotación objeto → tile). */
export function sampleScoRail(obj, scoPath, tileOrigin, segments = null) {
  const n = segments ?? segmentCount(scoPath.length, scoPath.radius);
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const d = (scoPath.length * i) / n;
    const local = splineLocalAt(
      scoPath.sx,
      scoPath.sy,
      scoPath.angle,
      scoPath.radius,
      d,
      scoPath.sz,
    );
    const p = rotateY({ x: local.x, z: local.y }, obj.rotation);
    const wx = tileOrigin.x + obj.x + p.x;
    const wz = tileOrigin.z + obj.y + p.z;
    const wy = obj.z + local.z;
    pts.push([wx, wy, wz]);
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
