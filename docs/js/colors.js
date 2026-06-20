/** Colores estilo editor OMSI 2 / cronología de rutas */
export const RAIL_TYP = {
  0: { stroke: "#b8c4d4", label: "Coche / bus (typ 0)" },
  1: { stroke: "#e0c090", label: "Peatón (typ 1)" },
  2: { stroke: "#e07070", label: "Tren (typ 2)" },
};

/** Paths de spline (.sli) — más visibles que el fondo oscuro del visor. */
export const SPLINE_RAIL = {
  0: { stroke: "#8ec8ff" },
  1: { stroke: "#e0c090" },
  2: { stroke: "#e07070" },
};

/** Paleta de rutas (.ttr) — colores vivos como en OMSI */
export const ROUTE_PALETTE = [
  "#ff3333",
  "#33cc33",
  "#3399ff",
  "#ffcc00",
  "#ff33ff",
  "#00cccc",
  "#ff8833",
  "#9966ff",
  "#66ff99",
  "#ff6699",
];

export const FREE_START = {
  stroke: "#84cc16",
  glow: "rgba(132, 204, 22, 0.45)",
};

export const BUSSTOP = {
  fill: "#f97316",
  stroke: "#1a1208",
};

export const SELECTED = {
  stroke: "#ffffff",
};
