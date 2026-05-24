export interface MicCapture {
  stop: () => void;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(buffer: Float32Array, from: number, to: number) {
  if (to === from) return buffer;
  const ratio = from / to;
  const newLen = Math.round(buffer.length / ratio);
  const out = new Float32Array(newLen);
  let oi = 0;
  let i = 0;
  while (oi < newLen) {
    const next = Math.round((oi + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (; i < next && i < buffer.length; i++) {
      sum += buffer[i];
      count++;
    }
    out[oi] = count > 0 ? sum / count : 0;
    oi++;
  }
  return out;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export interface MicOptions {
  onChunk: (pcm16k: Int16Array) => void;
  onLevel?: (rms: number) => void;
}

export async function startMicCapture(opts: MicOptions): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    opts.onLevel?.(rms(input));
    const down = downsample(input, ctx.sampleRate, 16000);
    opts.onChunk(floatTo16BitPCM(down));
  };
  src.connect(processor);
  processor.connect(ctx.destination);
  return {
    stop: () => {
      processor.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    },
  };
}

export class PcmPlayer {
  private ctx: AudioContext;
  private next = 0;
  private active: AudioBufferSourceNode[] = [];
  constructor(private sampleRate = 24000) {
    this.ctx = new AudioContext({ sampleRate });
  }
  resume() {
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  isPlaying() {
    return this.next > this.ctx.currentTime;
  }
  play(pcm: Int16Array) {
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;
    const buf = this.ctx.createBuffer(1, float.length, this.sampleRate);
    buf.copyToChannel(float, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    const start = Math.max(now, this.next);
    src.start(start);
    this.next = start + buf.duration;
    this.active.push(src);
    src.onended = () => {
      this.active = this.active.filter((s) => s !== src);
    };
  }
  hardStop() {
    for (const s of this.active) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.active = [];
    this.next = this.ctx.currentTime;
  }
  stop() {
    this.hardStop();
  }
}
