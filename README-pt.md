# dsh-lineup-manager

**Escolha quais linhas de modelos aparecem no seletor de modelos do DeepSeek Harness — agrupadas por provedor e atualizadas ao vivo de cada plataforma.**

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

> Tradução orientativa. A versão completa e atualizada está em English.

## Compatibility

| Superfície | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sem código nativo, sem toolchain de build) |

## The problem

O DSH agrupa o seletor de modelos por provedor, mas quantas entradas aparecem depende da sua configuração: um provedor que declara uma lista `models:` mostra apenas essas linhas; um sem ela mostra o catálogo completo do adaptador, que pode ter centenas de entradas. Manter só as linhas gratuitas exigia editar YAML à mão.

## Features

- Caixas de seleção por provedor para cada linha declarada
- Ações em massa: **Todas** / **Nenhuma** / **Somente free**
- **Atualizar** — consulta a lista atual da plataforma e marca linhas **novas** e **removidas**
- Linhas novas ficam selecionáveis imediatamente, antes de existirem na sua configuração

## Install

```sh
pnpm pack
dsh plugin add ./dsh-lineup-manager-0.2.0.tgz
```

Reinicie o DSH depois.

## Usage

1. Abra **Configurações → o botão "Lineups"**
2. O painel lista cada provedor com uma caixa por linha
3. Use **Todas** / **Nenhuma** / **Somente free** e clique em **Salvar** naquele grupo
4. **Reinicie o DSH** para o seletor refletir a mudança

## Safety

Toda gravação cria backup com carimbo de tempo, validação estrutural e releitura de verificação que reverte em caso de divergência. Apenas o bloco `models:` do provedor alvo é reescrito; o resto do arquivo não é tocado.

## How refresh works (and the traps)

- **Atualizar nunca grava**: apenas marca; nada é salvo até você clicar em Salvar
- **O catálogo embutido do pi-ai é evitado**: consultá-lo retornaria uma lista congelada na sua versão do DSH, ou seja, dados obsoletos
- **Um 401 `api_key_expired`** aparece como falha daquele provedor, sem afetar os outros

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
