import "./env.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { runPipeline } from "./agents.js";
import { attachLiveProxy } from "./live.js";
import type { AgentEvent } from "../../shared/types.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
});

app.get("/api/compile", async (req, res) => {
  const transcript = String(req.query.transcript ?? "").trim();
  const youtubeUrl = req.query.youtubeUrl
    ? String(req.query.youtubeUrl)
    : undefined;
  const sport = req.query.sport ? String(req.query.sport) : "golf";
  if (!transcript) {
    res.status(400).json({ error: "transcript required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await runPipeline(
      transcript,
      (e) => send({ ...e, ts: Date.now() }),
      { youtubeUrl, sport },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send({
      ts: Date.now(),
      stage: "error",
      status: "error",
      message: msg,
    });
  } finally {
    res.end();
  }
});

const PORT = Number(process.env.PORT ?? 8788);
const server = createServer(app);
attachLiveProxy(server);
server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});
