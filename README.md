# 3D Tetrinet — 6-Player Web-Arena

Eine 3D-Neuauflage von **Tetrinet** im Browser: 6 Spieler in einem hufeisenförmigen
3D-Raum, klassisches Tetris + die 9 Tetrinet-Specials, Server-Authoritative via
WebSocket, flüssige 3D-Effekte mit **Three.js (WebGL)**.

Regelspezifikation: [`md/game.md`](md/game.md) · Projektstruktur: [`md/project.md`](md/project.md)

## Technologie
- **Client:** Vite + TypeScript + Three.js, `socket.io-client`
- **Server:** Node.js + TypeScript + `socket.io` (20Hz Game-Loop)
- **Shared:** Gemeinsame Typen, Konstanten & 2D-Spiellogik (Client-Prediction + Server-Validierung)

## Struktur
```
packages/
  shared/   # Typen, Konstanten, tetrisLogic (reine 2D-Mathematik)
  server/   # WebSocket-Server, Room, GameLoop
  client/   # Vite-Frontend, Three.js-Rendering, UI-Overlay
```

## Entwicklung starten
```bash
npm install
npm run dev          # startet Server + Client parallel
```

- Client: http://localhost:5173
- Server: http://localhost:3000

### Individuell
```bash
npm run dev:server
npm run dev:client
```

## Build
```bash
npm run build
npm start            # produzierten Server starten
```

## Steuerung
| Taste | Aktion |
| :-- | :-- |
| `←` / `→` | Block links/rechts |
| `↑` | Drehen |
| `↓` | Soft Drop |
| `Space` | Hard Drop |
| `Shift` | Special im Inventar wechseln |
| `1`–`6` | Selected Special auf Gegner 1–6 abfeuern |

## Specials
`A` Add Line · `C` Clear Line · `B` Clear Specials · `R` Random Clear · `O` Block Bomb ·
`I` Invert · `G` Gravity · `Q` Quake · `N` Nuke
