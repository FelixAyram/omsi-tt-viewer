# OMSI 2 — Visor de rieles y rutas

Visualizador web de **rieles** (splines `.sli` + paths `.sco`), **busstops** y **rutas** (`.ttr`) de mapas OMSI 2. Colores de ruta al estilo cronología del editor.

**Sitio:** https://felixayram.github.io/omsi-tt-viewer/

## Uso online

1. Abre el sitio de GitHub Pages.
2. Elige un mapa precargado o sube un JSON exportado.
3. Marca rutas en la lista para resaltar sus rieles en color.
4. Activa **Solo rieles libres** para ver paths de inicio sin conexión entrante.

Controles: arrastrar = mover, rueda = zoom, clic = detalle del riel.

## Exportar un mapa (local)

```powershell
python tools/export_map_json.py "F:\SteamLibrary\steamapps\common\OMSI 2\maps\Test_Lat30"
```

Genera `docs/data/<nombre_mapa>.json`. Añade una entrada en `docs/data/manifest.json` para publicarla en Pages, o sube el JSON directamente en el navegador.

Variable opcional `OMSI_SDK` si el SDK no está en la ruta por defecto de Steam.

## Desarrollo local

```powershell
cd docs
python -m http.server 8080
```

Abre http://localhost:8080

## Estructura

- `docs/` — sitio estático (GitHub Pages)
- `tools/export_map_json.py` — exportador desde mapa OMSI
- `.github/workflows/pages.yml` — despliegue automático

Los datos del mapa no se leen del disco en el navegador: hay que exportar JSON con el script Python.
