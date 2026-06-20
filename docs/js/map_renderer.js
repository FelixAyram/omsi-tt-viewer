/** Índice espacial y dibujo por lotes para mapas con decenas de miles de rieles. */

const DEFAULT_CELL = 80;

function railPoints(rail) {
  if (rail.points?.length >= 2) return rail.points;
  if (rail.start && rail.end) return [rail.start, rail.end];
  return [];
}

function bboxFromPoints(pts) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]);
    maxZ = Math.max(maxZ, p[2]);
  }
  return { minX, maxX, minZ, maxZ };
}

export function buildRailSpatialIndex(rails) {
  const items = [];
  const grid = new Map();
  let cellSize = DEFAULT_CELL;

  for (const rail of rails) {
    const pts = railPoints(rail);
    if (pts.length < 2) continue;
    const bb = bboxFromPoints(pts);
    if (!Number.isFinite(bb.minX)) continue;
    items.push({ rail, pts, bb });
  }

  if (items.length > 50000) cellSize = 120;
  else if (items.length > 20000) cellSize = 100;

  for (let i = 0; i < items.length; i += 1) {
    const { bb } = items[i];
    const x0 = Math.floor(bb.minX / cellSize);
    const x1 = Math.floor(bb.maxX / cellSize);
    const z0 = Math.floor(bb.minZ / cellSize);
    const z1 = Math.floor(bb.maxZ / cellSize);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gz = z0; gz <= z1; gz += 1) {
        const key = `${gx},${gz}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  }

  return { items, grid, cellSize };
}

export function visibleWorldRect(view, width, height, mirrorX, margin = 0.15) {
  const halfW = width / (2 * view.scale);
  const halfH = height / (2 * view.scale);
  const mx = (halfW + margin / view.scale);
  const mz = (halfH + margin / view.scale);
  return {
    minX: view.offsetX - mx,
    maxX: view.offsetX + mx,
    minZ: view.offsetY - mz,
    maxZ: view.offsetY + mz,
  };
}

function bboxIntersects(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function queryVisibleRails(index, worldRect) {
  if (!index?.items?.length) return [];
  const { items, grid, cellSize } = index;
  const x0 = Math.floor(worldRect.minX / cellSize);
  const x1 = Math.floor(worldRect.maxX / cellSize);
  const z0 = Math.floor(worldRect.minZ / cellSize);
  const z1 = Math.floor(worldRect.maxZ / cellSize);
  const seen = new Set();
  const out = [];
  for (let gx = x0; gx <= x1; gx += 1) {
    for (let gz = z0; gz <= z1; gz += 1) {
      const bucket = grid.get(`${gx},${gz}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const item = items[idx];
        if (bboxIntersects(item.bb, worldRect)) out.push(item);
      }
    }
  }
  return out;
}

/** Hit-test: solo rieles cerca del punto (metros). */
export function findRailNear(index, x, z, thresholdM) {
  if (!index?.items?.length) return null;
  const { grid, cellSize, items } = index;
  const gx = Math.floor(x / cellSize);
  const gz = Math.floor(z / cellSize);
  const radius = Math.max(1, Math.ceil(thresholdM / cellSize));
  let best = null;
  let bestD = thresholdM;
  const seen = new Set();

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const bucket = grid.get(`${gx + dx},${gz + dz}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const { rail, pts, bb } = items[idx];
        if (x < bb.minX - thresholdM || x > bb.maxX + thresholdM) continue;
        if (z < bb.minZ - thresholdM || z > bb.maxZ + thresholdM) continue;
        const d = distPointPolylineFast(x, z, pts);
        if (d < bestD) {
          bestD = d;
          best = rail;
        }
      }
    }
  }
  return best;
}

function distPointPolylineFast(px, pz, points) {
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

/**
 * Dibuja rieles agrupados por estilo (menos llamadas a stroke).
 * @returns {number} rieles dibujados
 */
export function drawRailsBatched(ctx, visibleItems, {
  worldToScreen,
  routeRails,
  showAll,
  freeOnly,
  selectedRailId,
  styles,
  liteMode = false,
}) {
  const batches = new Map();

  for (const { rail, pts } of visibleItems) {
    const routeColors = routeRails.get(rail.id);
    const onRoute = routeColors && routeColors.length > 0;

    if (rail.invis && !rail.onlyEditor && !onRoute) continue;
    if (freeOnly && !rail.freeStart) continue;
    if (!showAll && !onRoute && !freeOnly) continue;
    if (!showAll && freeOnly && !rail.freeStart && !onRoute) continue;

    let strokeStyle;
    let lineWidth;
    let glow = false;

    if (selectedRailId === rail.id) {
      strokeStyle = styles.selected.stroke;
      lineWidth = styles.selected.width;
    } else if (onRoute) {
      strokeStyle = routeColors[0];
      lineWidth = styles.route.width;
      glow = !liteMode;
    } else if (rail.freeStart && (showAll || freeOnly)) {
      strokeStyle = styles.freeStart.stroke;
      lineWidth = styles.freeStart.width;
      glow = !liteMode;
    } else {
      const typ = styles.railTyp[rail.typ] || styles.railTyp[0];
      strokeStyle = typ.stroke;
      lineWidth = styles.base.width;
    }

    const key = `${strokeStyle}|${lineWidth}|${glow ? 1 : 0}`;
    if (!batches.has(key)) {
      batches.set(key, { strokeStyle, lineWidth, glow, segments: [] });
    }
    batches.get(key).segments.push(pts);
  }

  let drawn = 0;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowBlur = 0;

  for (const batch of batches.values()) {
    ctx.strokeStyle = batch.strokeStyle;
    ctx.lineWidth = batch.lineWidth;
    if (batch.glow) {
      ctx.shadowColor = batch.strokeStyle;
      ctx.shadowBlur = 6;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.beginPath();
    for (const pts of batch.segments) {
      const first = worldToScreen(pts[0][0], pts[0][2]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < pts.length; i += 1) {
        const p = worldToScreen(pts[i][0], pts[i][2]);
        ctx.lineTo(p.x, p.y);
      }
      drawn += 1;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  return drawn;
}
