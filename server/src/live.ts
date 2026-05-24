import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "node:http";

const GEMINI_WS = (key: string) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key,
  )}`;

function rawToString(data: RawData, isBinary: boolean): string {
  if (isBinary) return Buffer.from(data as Buffer).toString("utf-8");
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

export function attachLiveProxy(server: Server) {
  const wss = new WebSocketServer({ server, path: "/live" });
  wss.on("connection", (client) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      client.close(1011, "GEMINI_API_KEY missing on server");
      return;
    }
    console.log("[live] client connected, opening upstream");
    const upstream = new WebSocket(GEMINI_WS(key));
    const queue: string[] = [];
    let upstreamOpen = false;

    upstream.on("open", () => {
      upstreamOpen = true;
      console.log("[live] upstream open");
      for (const m of queue) upstream.send(m);
      queue.length = 0;
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const text = rawToString(data, isBinary);
      client.send(text);
    });
    upstream.on("close", (code, reason) => {
      const r = reason?.toString() ?? "";
      console.log(`[live] upstream closed ${code} ${r}`);
      if (client.readyState === WebSocket.OPEN) {
        if (r) client.send(JSON.stringify({ upstreamClose: { code, reason: r } }));
        client.close(code === 1000 ? 1000 : 1011, r || `upstream ${code}`);
      }
    });
    upstream.on("error", (err) => {
      console.error("[live] upstream error", err.message);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ upstreamError: { message: err.message } }));
        client.close(1011, err.message);
      }
    });

    client.on("message", (data, isBinary) => {
      const payload = rawToString(data, isBinary);
      if (upstreamOpen) upstream.send(payload);
      else queue.push(payload);
    });
    client.on("close", () => {
      console.log("[live] client closed");
      if (
        upstream.readyState === WebSocket.OPEN ||
        upstream.readyState === WebSocket.CONNECTING
      ) {
        upstream.close();
      }
    });
    client.on("error", () => upstream.close());
  });
}
