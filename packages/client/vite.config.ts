import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    // NIGHT-16.5 (LAN-Fix): Socket.io läuft SAME-ORIGIN über den Vite-Proxy.
    // Ein LAN-Spieler, der http://<IP>:5173/ aufruft, verbindet den Socket
    // zu http://<IP>:5173/socket.io → Vite leitet das (inkl. WebSocket-Upgrade)
    // intern auf den echten Server weiter. Damit reicht EIN offener Port (5173)
    // und es gibt keinen Cross-Port/CORS-Konflikt im LAN.
    proxy: {
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three.js + socket.io in eigene, cache-fähige Chunks splitten
        manualChunks: {
          three: ["three"],
          "socket-io": ["socket.io-client"],
        },
      },
    },
  },
});
