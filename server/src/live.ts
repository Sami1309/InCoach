import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "node:http";
import { Modality, type LiveServerMessage, type Session } from "@google/genai";
import { ai, LIVE_MODEL } from "./gemini.js";

function rawToString(data: RawData, isBinary: boolean): string {
  if (isBinary) return Buffer.from(data as Buffer).toString("utf-8");
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

export function attachLiveProxy(server: Server) {
  const wss = new WebSocketServer({ server, path: "/live" });

  wss.on("connection", async (client) => {
    if (!process.env.GEMINI_API_KEY) {
      client.close(1011, "GEMINI_API_KEY missing on server");
      return;
    }
    console.log("[live] client connected");

    let session: Session | null = null;
    let ready = false;
    const queue: Array<Record<string, unknown>> = [];

    const sendToClient = (obj: unknown) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(obj));
      }
    };

    const drain = () => {
      if (!session) return;
      for (const m of queue) routeClientMessage(session, m);
      queue.length = 0;
    };

    const handleServerMessage = (m: LiveServerMessage) => {
      try {
        sendToClient(m);
      } catch (err) {
        console.error("[live] forward error", err);
      }
    };

    try {
      session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [
              {
                text: "You are an encouraging, concise live coach. Reply in one breath — one or two short sentences max. The client gives you the routine and current step via [STATE] messages. When the user asks you to demonstrate, show a moment, advance, or replay, CALL the matching tool (play_step / show_moment) so the UI follows along, then briefly narrate what they will see. Don't describe the tool — just call it.",
              },
            ],
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: "play_step",
                  description:
                    "Switch the user's drill to step at the given index and start playing its video. Use this when the user asks to start, restart, skip ahead, go back, or move on.",
                  parameters: {
                    type: "OBJECT" as never,
                    properties: {
                      step_index: {
                        type: "INTEGER" as never,
                        description: "0-based drill step index",
                      },
                    },
                    required: ["step_index"],
                  },
                },
                {
                  name: "show_moment",
                  description:
                    "Within the current drill step's video, jump to a specific key moment (0-based). Use when the user asks to see the setup, the strike, the follow-through, or any specific phase.",
                  parameters: {
                    type: "OBJECT" as never,
                    properties: {
                      moment_index: {
                        type: "INTEGER" as never,
                        description:
                          "0-based moment index within the current step's video",
                      },
                    },
                    required: ["moment_index"],
                  },
                },
              ],
            },
          ],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("[live] upstream open");
            ready = true;
            sendToClient({ setupComplete: {} });
            drain();
          },
          onmessage: handleServerMessage,
          onerror: (e) => {
            const msg =
              (e as { message?: string } | undefined)?.message ?? "upstream error";
            console.error("[live] upstream error", msg);
            sendToClient({ upstreamError: { message: msg } });
          },
          onclose: (e) => {
            const reason =
              (e as { reason?: string } | undefined)?.reason ?? "";
            const code = (e as { code?: number } | undefined)?.code ?? 1000;
            console.log(`[live] upstream closed ${code} ${reason}`);
            sendToClient({ upstreamClose: { code, reason } });
            if (client.readyState === WebSocket.OPEN) client.close(1000, reason);
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[live] connect failed", msg);
      sendToClient({ upstreamError: { message: msg } });
      client.close(1011, msg);
      return;
    }

    client.on("message", (data, isBinary) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawToString(data, isBinary));
      } catch (err) {
        console.error("[live] bad client json", err);
        return;
      }
      if (!session) return;
      if (!ready) {
        queue.push(parsed);
        return;
      }
      routeClientMessage(session, parsed);
    });

    client.on("close", () => {
      console.log("[live] client closed");
      try {
        session?.close();
      } catch {
        /* ignore */
      }
    });
    client.on("error", () => {
      try {
        session?.close();
      } catch {
        /* ignore */
      }
    });
  });
}

function routeClientMessage(
  session: Session,
  msg: Record<string, unknown>,
): void {
  const realtime = msg.realtimeInput as
    | {
        audio?: { data?: string; mimeType?: string };
        video?: { data?: string; mimeType?: string };
        text?: string;
      }
    | undefined;
  if (realtime?.audio?.data) {
    session.sendRealtimeInput({
      audio: {
        data: realtime.audio.data,
        mimeType: realtime.audio.mimeType ?? "audio/pcm;rate=16000",
      },
    });
    return;
  }
  if (realtime?.video?.data) {
    session.sendRealtimeInput({
      video: {
        data: realtime.video.data,
        mimeType: realtime.video.mimeType ?? "image/jpeg",
      },
    });
    return;
  }
  if (typeof realtime?.text === "string") {
    session.sendRealtimeInput({ text: realtime.text });
    return;
  }
  const cc = msg.clientContent as
    | {
        turns?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
        turnComplete?: boolean;
      }
    | undefined;
  if (cc) {
    session.sendClientContent({
      turns: (cc.turns ?? []).map((t) => ({
        role: t.role ?? "user",
        parts: (t.parts ?? []).map((p) => ({ text: p.text ?? "" })),
      })),
      turnComplete: cc.turnComplete ?? true,
    });
    return;
  }
  const tr = msg.toolResponse as
    | { functionResponses?: Array<{ id: string; name?: string; response: unknown }> }
    | undefined;
  if (tr?.functionResponses) {
    session.sendToolResponse({
      functionResponses: tr.functionResponses.map((r) => ({
        id: r.id,
        name: r.name,
        response: r.response as Record<string, unknown>,
      })),
    });
    return;
  }
}
