# dsh-lineup-manager

**Elige qué líneas de modelos aparecen en el selector de modelos de DeepSeek Harness — agrupadas por proveedor y actualizadas en vivo desde cada plataforma.**

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

> Traducción orientativa. La versión completa y actualizada está en English.

## Compatibility

| Superficie | Estado |
|---|---|
| Harness | DeepSeek Harness `0.2.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sin código nativo, sin cadena de compilación) |

## The problem

DSH agrupa el selector de modelos por proveedor, pero cuántas entradas aparecen depende de tu configuración: un proveedor que declara una lista `models:` muestra solo esas líneas; uno sin ella muestra el catálogo completo del adaptador, que puede tener cientos de entradas. Mantener solo las líneas gratuitas obligaba a editar YAML a mano.

## Features

- Casillas por proveedor para cada línea declarada
- Acciones masivas: **Todas** / **Ninguna** / **Solo free**
- **Actualizar** — consulta la lista actual de la plataforma y marca líneas **nuevas** y **desaparecidas**
- Las líneas nuevas se pueden marcar de inmediato, antes de existir en tu configuración

## Install

```sh
pnpm pack
dsh plugin add ./dsh-lineup-manager-0.2.0.tgz
```

Reinicia DSH después.

## Usage

1. Abre **Ajustes → el botón "Lineups"**
2. El panel lista cada proveedor con una casilla por línea
3. Usa **Todas** / **Ninguna** / **Solo free** y pulsa **Guardar** en ese grupo
4. **Reinicia DSH** para que el selector lo refleje

## Safety

Cada escritura crea una copia de seguridad con marca de tiempo, una validación estructural y una relectura de verificación que revierte si algo no coincide. Solo se reescribe el bloque `models:` del proveedor objetivo; el resto del archivo no se toca.

## How refresh works (and the traps)

- **Actualizar nunca escribe**: solo etiqueta; nada se guarda hasta que pulses Guardar
- **Se evita el catálogo integrado de pi-ai**: consultarlo devolvería una lista congelada en tu versión de DSH, es decir, datos obsoletos
- **Un 401 `api_key_expired`** se muestra como fallo de ese proveedor, sin afectar a los demás

## Layout

```
src/                  runtime sources
scripts/build.mjs     emits dist/, verifies the copy
tests/                plain-Node test suites
dist/                 build output (not tracked)
```

## Development

```sh
pnpm build        # emit + verify dist/
pnpm test         # 66 checks across four suites
```

## License

[MIT](LICENSE)
