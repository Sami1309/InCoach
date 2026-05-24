import { base64FromBytes, bytesFromBase64, PcmPlayer } from "./audio";

export type LiveEvent =
  | { kind: "open" }
  | { kind: "close"; reason?: string }
  | { kind: "transcript"; role: "user" | "model"; text: string }
  | { kind: "turnStart"; role: "user" | "model" }
  | { kind: "turnEnd"; role: "user" | "model" }
  | { kind: "interrupted" }
  | { kind: "modelAudio" }
  | { kind: "toolCall"; id: string; name: string; args: unknown }
  | { kind: "info"; text: string }
  | { kind: "error"; message: string };

export interface LiveOptions {
  systemInstruction: string;
  onEvent: (e: LiveEvent) => void;
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private player = new PcmPlayer(24000);
  private opts: LiveOptions;
  private opened = false;
  constructor(opts: LiveOptions) {
    this.opts = opts;
  }

  isOpen() {
    return this.opened;
  }

  connect() {
    this.player.resume();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/live`);
    this.ws = ws;
    ws.onopen = () => {
      const setup = {
        setup: {
          model: "models/gemini-3.5-flash",
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: {
            parts: [{ text: this.opts.systemInstruction }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
      ws.send(JSON.stringify(setup));
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = (ev) => {
      this.opened = false;
      this.opts.onEvent({
        kind: "close",
        reason: ev.reason || `code ${ev.code}`,
      });
    };
    ws.onerror = () => {
      this.opts.onEvent({ kind: "error", message: "WebSocket error" });
    };
  }

  private handleMessage(raw: unknown) {
    let data: Record<string, unknown>;
    try {
      data =
        typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }
    if (data.setupComplete && !this.opened) {
      this.opened = true;
      this.opts.onEvent({ kind: "open" });
      this.opts.onEvent({ kind: "info", text: "Live session ready" });
    }
    const upstreamErr = data.upstreamError as { message?: string } | undefined;
    if (upstreamErr?.message) {
      this.opts.onEvent({
        kind: "error",
        message: `upstream: ${upstreamErr.message}`,
      });
    }
    const upstreamClose = data.upstreamClose as
      | { code?: number; reason?: string }
      | undefined;
    if (upstreamClose) {
      this.opts.onEvent({
        kind: "info",
        text: `upstream closed ${upstreamClose.code ?? ""} ${upstreamClose.reason ?? ""}`,
      });
    }
    const sc = data.serverContent as
      | {
          modelTurn?: {
            parts?: Array<{
              inlineData?: { data?: string; mimeType?: string };
            }>;
          };
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          interrupted?: boolean;
          turnComplete?: boolean;
          generationComplete?: boolean;
        }
      | undefined;
    if (sc?.interrupted) {
      this.player.hardStop();
      this.opts.onEvent({ kind: "interrupted" });
    }
    if (sc?.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        const inline = p.inlineData;
        if (
          inline?.data &&
          (inline.mimeType?.startsWith("audio/pcm") ||
            inline.mimeType?.startsWith("audio/L16") ||
            inline.mimeType?.startsWith("audio/wav"))
        ) {
          const bytes = bytesFromBase64(inline.data);
          const pcm = new Int16Array(
            bytes.buffer,
            bytes.byteOffset,
            Math.floor(bytes.byteLength / 2),
          );
          this.player.play(pcm);
          this.opts.onEvent({ kind: "modelAudio" });
        }
      }
    }
    if (sc?.inputTranscription?.text) {
      this.opts.onEvent({
        kind: "transcript",
        role: "user",
        text: sc.inputTranscription.text,
      });
    }
    if (sc?.outputTranscription?.text) {
      this.opts.onEvent({
        kind: "transcript",
        role: "model",
        text: sc.outputTranscription.text,
      });
    }
    if (sc?.turnComplete) {
      this.opts.onEvent({ kind: "turnEnd", role: "model" });
    }
    if (sc?.generationComplete) {
      this.opts.onEvent({ kind: "turnEnd", role: "model" });
    }
    const tc = data.toolCall as
      | { functionCalls?: Array<{ id: string; name: string; args: unknown }> }
      | undefined;
    if (tc?.functionCalls) {
      for (const c of tc.functionCalls) {
        this.opts.onEvent({
          kind: "toolCall",
          id: c.id,
          name: c.name,
          args: c.args,
        });
        this.sendToolResponse(c.id, { status: "ok" });
      }
    }
  }

  sendAudio(pcm: Int16Array) {
    if (!this.opened || this.ws?.readyState !== WebSocket.OPEN) return;
    const b64 = base64FromBytes(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    );
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: b64 },
        },
      }),
    );
  }

  sendImage(jpegB64: string) {
    if (!this.opened || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          video: { mimeType: "image/jpeg", data: jpegB64 },
        },
      }),
    );
  }

  sendText(text: string) {
    if (!this.opened || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
  }

  sendToolResponse(id: string, response: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: { functionResponses: [{ id, response }] },
      }),
    );
  }

  close() {
    this.opened = false;
    this.player.stop();
    this.ws?.close();
    this.ws = null;
  }
}
