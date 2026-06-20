# Rutas `.ttr` en OMSI 2 — formato, visor y reparación

Guía consolidada a partir del visor web (`omsi-tt-viewer`), el SDK `movimiento_calle` y pruebas en **Test_Lat30** y **Ahlheim 4**.

## Qué es un `.ttr`

Archivo de **trazado** (track) en `TTData/`. Cada línea de autobús (`.ttp`) apunta a un `.ttr` hermano. OMSI lee una lista de bloques `[track_entry]` que dicen *en qué riel* está el bus en cada punto del recorrido.

```
0:
[track_entry]
11
1
1
48291
12.500
0
```

| Campo (orden) | Nombre SDK | Significado |
|---------------|------------|-------------|
| `11` | `element_id` | ID de instancia en el `.map` (`[spline]` o `[object]`) |
| `1` | `path_idx` | Índice del path en el `.sli` o `.sco` de ese elemento |
| `1` | `route_id` / kachel | Grupo de ruta en el editor (suele ser `1`) |
| `48291` | `global_path` | **OMSI 2.3:** índice global en el grafo de tráfico (`PathIndex.path`) |
| `12.500` | `distance` / reldist | Metros **locales** a lo largo de ese path |
| `0` | `fstrn_count` | Semáforos permitidos (opcional + IDs) |

### Formato OMSI 2.3 vs legado

El visor y el SDK detectan el formato así:

- Si el 5.º campo tras `route_id` es un **entero** → **OMSI 2.3** (`global_path` + `distance`).
- Si es un **decimal** → legado (`distance`, `speed`, `flag`).

OMSI 2.3 hace `StrToInt` en la línea del `global_path`. Si ahí hay un float, el mapa **no carga** la ruta (error en log ~línea 13 + índice×9).

El reparador restaura entradas desde `TTData_backup_pre_repair/` cuando existe backup nativo.

---

## `path_idx`: splines vs objetos (¡importante!)

| Origen | Indexación | Ejemplo |
|--------|------------|---------|
| **Spline** (`.sli`) | **0-based** | Primer carril = `0`, segundo = `1` |
| **Objeto** (`.sco`) | **1-based** | Primer `[path]` = `1`, segundo = `2` |

El **SDK** (`path_graph._parse_sco_paths`) y los `.ttr` oficiales usan **1-based en objetos**.

El visor web (`rail_builder.js` → `parseScoPaths`) numera objetos **0-based** internamente. Para **splines** coincide con OMSI; para **objetos** puede haber desfase de un índice al mostrar rutas con cruces `.sco`. El reparador Python usa el SDK (correcto para escritura de `.ttr`).

**Regla práctica:** en `.ttr`, `path_idx` del objeto = número del bloque `[path]` contando desde **1** en el `.sco`.

---

## Tipos de path (`typ`)

| `typ` | Uso OMSI | Visor web (rutas bus) |
|-------|----------|------------------------|
| `0` | Calle / autobús / coche | ✅ Se dibuja y cuenta |
| `1` | Peatón | ❌ Omitido |
| `2` | Tren / tranvía | ❌ Omitido en visor bus* |
| `3` | Avión / aeronave | ❌ Omitido en visor bus* |

\*El **reparador** sí distingue el typ de cada ruta (ver abajo).

### Modo de ruta (reparador)

OMSI no guarda “bus vs tren” en un campo del `.ttr`. El reparador **infiere el typ de toda la ruta** desde la **primera entrada válida** con typ conducible (`0`, `2` o `3`):

- Ruta que empieza en riel `typ=0` → todos los paths reparados serán `typ=0`
- Ruta que empieza en `typ=2` → conectividad y normalización solo con paths de tren
- Ruta que empieza en `typ=3` → solo paths de avión

En **Ahlheim 4** (ejemplo): ~779 rutas bus, ~41 rutas tren.

Aplicar parche SDK (una vez):

```powershell
python tools/patch_sdk_route_typ.py
```

Luego reparar solo geometría si ya corriste restore antes:

```powershell
python tools/repair_ttr.py repair "...\Ahlheim 4" --phases geometry
```

**Nota:** la fase `anchored` (anclas busstop) sigue pensada para líneas de bus con paradas `.ttp`; rutas de tren sin busstops no la usan.

---

## Cómo resuelve el visor cada entrada

Equivalente a `resolveTrackEntryRail()` en `docs/js/map_processor.js`:

1. **Tipo de elemento:** si `element_id` está en splines del mapa → `spline`, si no → `object`.
2. **Normalizar `path_idx`:**
   - Objeto: si no existe, elige el path **más cercano** por número.
   - Spline: si no existe, usa el primer path con `typ=0`.
3. **Buscar riel:** clave `spline:ID:path` u `object:ID:path` en el grafo generado.
4. **Omitir si:**
   - `missing` — no hay riel (ID inexistente, path ausente en `.sli`/`.sco`).
   - `non-vehicle` — `typ !== 0`.

Esto es **solo visualización**; no modifica el `.ttr` en disco.

---

## Inicio libre (spawn) y busstops

- **Inicio libre:** extremo de riel marcado como arranque de circulación (`freeStart` en el visor). Tramo verde desde `trafficStart` hasta el fin del path.
- **Busstop:** posición mundial desde la instancia en el `.map`; `along = offsetAlong - localLength` en paths de objeto (regla OMSI confirmada en Test_Lat30).
- **Anclas:** el reparador *anchored* (`ttr_anchor_repair`) **no mueve** las paradas del `.ttp`; ajusta el `track_entry` del índice `trackentry` de cada `[station]` para que el bus quede en el riel junto a la cajita morada.

---

## Tamaño de tile según latitud (alineado con Unity `omsi path`)

OMSI usa **dos modos** de tiles (ver `OmsiMapTileMetrics.cs` en `F:\unty\omsi path`):

| Tipo | Nombre del `.map` | Tamaño | Origen mundial |
|------|-------------------|--------|----------------|
| **Clásico** | `tile_0_0.map`, `tile_3640_5729.map` | **300 m** fijos | Rejilla uniforme `(tx−minTx)×300` |
| **Global** | Solo dígitos ≥5 (`153835.map`) | **611,5 × cos(lat)** por tile | Suma acumulada del ancho de tiles vecinos |

**Latitud en tiles globales:** se decodifica del **nombre del archivo**, no de `[mapcam]`:

- `153835` → `153835 / 10000` = **15,3835°**
- Códigos ≥100000 → `/10000`; ≥10000 → `/1000`

Ejemplos de tamaño:

| Latitud (nombre) | Tile aprox. |
|----------------|-------------|
| 0° (ecuador) | 611,5 m |
| 15,38° | ~590 m |
| 30° | ~530 m |
| 52,5° (Berlín) | ~372 m |

Mapas como **Test_Lat30** o **Ahlheim 4** (`tile_*`) usan el modo **clásico 300 m**.  
Mapas mundiales OMSI con tiles numéricos usan el modo **global** con layout Mercator acumulativo.

El visor (v42+), `tools/repair_ttr.py` y `tools/export_map_json.py` replican esta lógica.  
Módulo: `tools/omsi_tile_size.py`. Parche SDK: `python tools/patch_sdk_route_typ.py`.

---

## Mapas enormes (Ahlheim 4)

Aprendizajes del visor **v35** (WebGL):

- Coordenadas mundiales ~20 000–30 000 m pierden precisión en `float32` de la GPU.
- **Solución:** rebasar geometría al centro del mapa (`mapOrigin`) y acotar bounds con percentiles (ignorar outliers).
- Síntoma previo: pantalla negra + un cuadrado (una parada); stats mostraban ~89 k rieles cargados pero 0 segmentos visibles.

Esto no cambia el `.ttr`, pero explica por qué el visor podía parecer “roto” mientras el mapa sí procesaba.

---

## Herramientas de reparación

### En este repo

```powershell
# Solo auditar (sin tocar archivos)
python tools/repair_ttr.py audit "F:\SteamLibrary\steamapps\common\OMSI 2\maps\Ahlheim 4"

# Reparación completa (backup + geometría + anclas busstop)
python tools/repair_ttr.py repair "F:\SteamLibrary\steamapps\common\OMSI 2\maps\Ahlheim 4"

# Simular sin escribir
python tools/repair_ttr.py repair "...\Ahlheim 4" --dry-run --phases geometry,anchored
```

**Fases:**

| Fase | Qué hace |
|------|----------|
| `restore` | Copia/restaura desde `TTData_backup_pre_repair`; recupera `global_path` entero OMSI 2.3 |
| `geometry` | `repair_entry_omsi` en cada entrada: conectividad, distancias, typ=0, entry0 fantasma |
| `anchored` | Anclas en busstops + relleno de segmentos entre paradas (`.ttp` intacto) |

Informes JSON en `<mapa>/_ttdata_reports/`.

Variables de entorno: `OMSI_ROOT`, `OMSI_SDK`, `REPAIR_CPU_WORKERS`.

### En el SDK (`OMSI 2/SDK/movimiento_calle`)

| Módulo | Rol |
|--------|-----|
| `repair_ttdata.py` | CLI rápido: solo fase restore |
| `repair_ttdata_anchored.py` | CLI anclas busstop |
| `ttr_omsi.py` | Validación + `repair_entry_omsi` |
| `ttr_anchor_repair.py` | Lógica de anclas y relleno |
| `ttr_v23.py` | Restauración formato 2.3 |

---

## Códigos de auditoría OMSI (`validate_ttr_omsi`)

| Código | Significado |
|--------|-------------|
| `missing_element` | `element_id` no está en el mapa |
| `missing_sli_path` | Path inexistente en `.sli` |
| `missing_sco_path` | Path inexistente en `.sco` |
| `wrong_path_typ` | Path con typ distinto al de la ruta (inferido del inicio) |
| `non_vehicle_path` | *(legacy)* equivalente a `wrong_path_typ` con ruta bus |
| `distance_overflow` | `reldist` mayor que largo del segmento |
| `near_end` | Distancia ≥ ~85 % del path (OMSI rechaza) |
| `disconnected` | Entrada no conecta geométricamente con la anterior |

---

## Flujo recomendado para un mapa nuevo

1. **Copia de seguridad:** carpeta `TTData` completa (el script crea `TTData_backup_pre_repair` si no existe).
2. **Auditoría:** `python tools/repair_ttr.py audit ...`
3. **Reparar:** `python tools/repair_ttr.py repair ...`
4. **Comprobar en visor:** https://felixayram.github.io/omsi-tt-viewer/ — versión ≥ 42. Stats: `tile 300 m (clásico)` o `N tiles globales (~Xm, lat Y°)`.
5. **Probar en OMSI:** cargar línea en el simulador; revisar `logfile.txt` si falla `LoadTrack`.

---

## Referencias en el código

| Tema | Archivo |
|------|---------|
| Parseo `.ttr` | `docs/js/map_processor.js` → `parseTtr` |
| Resolución riel | `docs/js/map_processor.js` → `resolveTrackEntryRail` |
| Paths `.sli`/`.sco` | `docs/js/rail_builder.js` |
| Reparador unificado | `tools/repair_ttr.py` |
| Verificación campos | `tools/_verify_ttr_fields.py` |
| Export JSON visor | `tools/export_map_json.py` |
| Tile size / latitud | `tools/omsi_tile_size.py`, `map_processor.js` → `resolveTileSizeM` |

---

## Ahlheim 4 — notas

- ~820 archivos `.ttr`, ~89 k rieles en el visor.
- Tiles suelen estar en `copia/`; el grafo usa `map_tiles_dir()` (raíz o `copia/`).
- Muchas entradas omitidas en el visor son **esperables** (tranvía `typ=2`, IDs antiguos, paths de peatón). El reparador corrige lo geométricamente recuperable; no inventa splines borrados del mapa.
- Rutas con errores `riel no encontrado` tras reparar suelen necesitar edición manual en el editor de rutas OMSI o actualizar el `.ttr` desde un backup de versión de mapa compatible.
