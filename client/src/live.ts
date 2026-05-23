import { base64FromBytes, bytesFromBase64, PcmPlayer } from "./audio";

export type LiveEvent =
  | { kind: "open" }
  | { kind: "close"; reason?: string }
  | { kind: "transcript"; role: "user" | "model"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: unknown }
  | { kind: "error"; message: string };

export interface LiveOptions {
  systemInstruction: string;
  onEvent: (e: LiveEvent) => void;
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private player = new PcmPlayer(24000);
  private opts: LiveOptions;
  constructor(opts: LiveOptions) {
    this.opts = opts;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/live`);
    this.ws = ws;
    ws.onopen = () => {
      this.player.resume();
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
      this.opts.onEvent({ kind: "open" });
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = (ev) =>
      this.opts.onEvent({ kind: "close", reason: ev.reason });
    ws.onerror = () =>
      this.opts.onEvent({ kind: "error", message: "WebSocket error" });
  }

  private handleMessage(raw: unknown) {
    let data: Record<string, unknown>;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }
    const sc = data.serverContent as
      | {
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
        }
      | undefined;
    if (sc?.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        const inline = p.inlineData;
        if (inline?.data && inline.mimeType?.startsWith("audio/pcm")) {
          const bytes = bytesFromBase64(inline.data);
          const pcm = new Int16Array(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength / 2,
          );
          this.player.play(pcm);
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
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const b64 = base64FromBytes(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    );
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: b64 }],
        },
      }),
    );
  }

  sendImage(jpegB64: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "image/jpeg", data: jpegB64 }],
        },
      }),
    );
  }

  sendText(text: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
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
    this.player.stop();
    this.ws?.close();
    this.ws = null;
  }
}
