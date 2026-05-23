import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

const GEMINI_WS = (key: string) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key,
  )}`;

export function attachLiveProxy(server: Server) {
  const wss = new WebSocketServer({ server, path: "/live" });
  wss.on("connection", (client) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      client.close(1011, "GEMINI_API_KEY missing on server");
      return;
    }
    const upstream = new WebSocket(GEMINI_WS(key));

    const queue: (string | Buffer)[] = [];
    let upstreamOpen = false;

    upstream.on("open", () => {
      upstreamOpen = true;
      for (const m of queue) upstream.send(m);
      queue.length = 0;
    });

    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    upstream.on("close", (code, reason) => {
      if (client.readyState === WebSocket.OPEN)
        client.close(code, reason.toString());
    });
    upstream.on("error", (err) => {
      console.error("[live] upstream error", err.message);
      if (client.readyState === WebSocket.OPEN) client.close(1011, err.message);
    });

    client.on("message", (data) => {
      const payload =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf-8")
            : Buffer.from(data as ArrayBuffer).toString("utf-8");
      if (upstreamOpen) upstream.send(payload);
      else queue.push(payload);
    });
    client.on("close", () => {
      if (upstream.readyState <= WebSocket.OPEN) upstream.close();
    });
    client.on("error", () => upstream.close());
  });
}
