import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, CompileResult } from "@shared/types";
import { initPose, startPoseLoop, type PoseTick } from "./pose";
import { startMicCapture, type MicCapture } from "./audio";
import { LiveSession, type LiveEvent } from "./live";

const MEMORY_KEY = "coach-compiler.session";

interface Memory {
  transcript: string;
  youtubeUrl?: string;
  sport: string;
  result?: CompileResult;
  savedAt: number;
}

export function App() {
  const [transcript, setTranscript] = useState(
    "I'm hitting a lot of fat shots with my 7-iron. Indoor mat at home, 15 minutes.",
  );
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [sport, setSport] = useState("golf");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [recalled, setRecalled] = useState<Memory | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [poseOn, setPoseOn] = useState(false);
  const [sway, setSway] = useState<number | null>(null);
  const stopPoseRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [liveOn, setLiveOn] = useState(false);
  const [transcripts, setTranscripts] = useState<LiveEvent[]>([]);
  const liveRef = useRef<LiveSession | null>(null);
  const micRef = useRef<MicCapture | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (raw) {
      try {
        setRecalled(JSON.parse(raw) as Memory);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const compile = async () => {
    setEvents([]);
    setResult(null);
    setCompiling(true);
    const params = new URLSearchParams({ transcript, sport });
    if (youtubeUrl.trim()) params.set("youtubeUrl", youtubeUrl.trim());
    const es = new EventSource(`/api/compile?${params.toString()}`);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as AgentEvent;
        setEvents((prev) => [...prev, ev]);
        if (ev.stage === "done" && ev.data) {
          const r = ev.data as CompileResult;
          setResult(r);
          const mem: Memory = {
            transcript,
            youtubeUrl: youtubeUrl || undefined,
            sport,
            result: r,
            savedAt: Date.now(),
          };
          localStorage.setItem(MEMORY_KEY, JSON.stringify(mem));
          setRecalled(mem);
        }
        if (ev.stage === "done" || ev.stage === "error") {
          es.close();
          setCompiling(false);
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es.close();
      setCompiling(false);
    };
  };

  const togglePose = async () => {
    if (poseOn) {
      stopPoseRef.current?.();
      stopPoseRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setPoseOn(false);
      setSway(null);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 600, facingMode: "user" },
    });
    streamRef.current = stream;
    const video = videoRef.current!;
    video.srcObject = stream;
    await video.play();
    await initPose();
    stopPoseRef.current = startPoseLoop(
      video,
      canvasRef.current!,
      (tick: PoseTick) => setSway(tick.swayScore),
    );
    setPoseOn(true);
  };

  const toggleLive = async () => {
    if (liveOn) {
      micRef.current?.stop();
      micRef.current = null;
      liveRef.current?.close();
      liveRef.current = null;
      setLiveOn(false);
      return;
    }
    const sys = `You are an encouraging ${sport} coach. The user is working on: "${transcript}". Keep cues short, calm, and corrective. If the user mentions pain, pause and recommend a safety screen.`;
    const session = new LiveSession({
      systemInstruction: sys,
      onEvent: (e) => setTranscripts((prev) => [...prev.slice(-40), e]),
    });
    session.connect();
    liveRef.current = session;
    micRef.current = await startMicCapture((pcm) => session.sendAudio(pcm));
    setLiveOn(true);
  };

  const recall = () => {
    if (!recalled) return;
    setTranscript(recalled.transcript);
    setYoutubeUrl(recalled.youtubeUrl ?? "");
    setSport(recalled.sport);
    if (recalled.result) setResult(recalled.result);
  };

  const platformLine = useMemo(() => {
    if (!result) return null;
    const intent = result.intent;
    return `${cap(intent.activity)} coach platform — first MVP: ${sport}. Compiles ${intent.durationMinutes}-min ${intent.skillLevel} routines from voice, validates them, and coaches live.`;
  }, [result, sport]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Coach Compiler
          <span className="sub mono">v0.1</span>
        </div>
        <div className="row">
          {recalled && (
            <button onClick={recall} title={`Saved ${timeAgo(recalled.savedAt)}`}>
              Recall last session
            </button>
          )}
          <span className={`pill ${liveOn ? "ok" : ""}`}>
            <span className="dot" style={dotStyle(liveOn)} /> Live voice
          </span>
          <span className={`pill ${poseOn ? "ok" : ""}`}>
            <span className="dot" style={dotStyle(poseOn)} /> Pose
          </span>
        </div>
      </header>

      <div className="main">
        <div className="col">
          <section className="card">
            <div className="card-header">
              <span className="card-title">Brief</span>
            </div>
            <div className="card-body controls">
              <div>
                <div className="label">Sport</div>
                <input
                  type="text"
                  value={sport}
                  onChange={(e) => setSport(e.target.value)}
                />
              </div>
              <div>
                <div className="label">What do you want to work on?</div>
                <textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                />
              </div>
              <div>
                <div className="label">YouTube reference (optional)</div>
                <input
                  type="text"
                  placeholder="https://youtube.com/..."
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                />
              </div>
              <div className="row between">
                <button
                  className="primary"
                  onClick={compile}
                  disabled={compiling || !transcript.trim()}
                >
                  {compiling ? "Compiling…" : "Compile routine"}
                </button>
                <button onClick={togglePose}>
                  {poseOn ? "Stop camera" : "Start camera"}
                </button>
                <button onClick={toggleLive} disabled={!result}>
                  {liveOn ? "End coach" : "Start coach"}
                </button>
              </div>
              {platformLine && (
                <div className="footer-line">{platformLine}</div>
              )}
            </div>
          </section>

          <section className="card" style={{ flex: 1 }}>
            <div className="card-header">
              <span className="card-title">Agent activity</span>
              <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>
                {events.length} events
              </span>
            </div>
            <div className="card-body">
              {events.length === 0 ? (
                <div className="empty">No agents running. Hit “Compile routine”.</div>
              ) : (
                <div className="timeline">
                  {events.map((e, i) => (
                    <EventCard key={i} e={e} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="col">
          <section className="card" style={{ flex: 1 }}>
            <div className="card-header">
              <span className="card-title">Live coach</span>
              {sway != null && (
                <span className="metric">
                  <span className="v mono">{sway.toFixed(1)}</span>
                  <span className="u">sway Δ</span>
                </span>
              )}
            </div>
            <div className="card-body" style={{ padding: 14 }}>
              <div className="coach">
                <video ref={videoRef} muted playsInline />
                <canvas ref={canvasRef} />
                {!poseOn && (
                  <div className="overlay">
                    Camera off — start it to see your pose.
                  </div>
                )}
              </div>
              <LiveTranscripts events={transcripts} />
            </div>
          </section>
        </div>

        <div className="col">
          <section className="card">
            <div className="card-header">
              <span className="card-title">Routine</span>
            </div>
            <div className="card-body">
              {result ? (
                <Routine result={result} />
              ) : (
                <div className="empty">No routine yet.</div>
              )}
            </div>
          </section>

          <section className="card" style={{ flex: 1 }}>
            <div className="card-header">
              <span className="card-title">Validator diff</span>
            </div>
            <div className="card-body">
              {result && result.diffs.length > 0 ? (
                <div>
                  {result.diffs.map((d, i) => (
                    <div className="diff" key={i}>
                      <div className="k">{d.field}</div>
                      <div>
                        <div className="before">− {d.before}</div>
                        <div className="after">+ {d.after}</div>
                        <div className="why">{d.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  {result ? "No corrections — clean draft." : "Awaiting compile."}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function EventCard({ e }: { e: AgentEvent }) {
  const cls = `event stage-${e.stage}`;
  return (
    <div className={cls}>
      <div className="top">
        <span className="stage">{e.stage}</span>
        <span className="ts mono">{fmtTime(e.ts)}</span>
      </div>
      <div className="msg">{e.message}</div>
      {e.status === "result" && Boolean(e.data) && (
        <pre className="data">{summarize(e.data)}</pre>
      )}
    </div>
  );
}

function Routine({ result }: { result: CompileResult }) {
  const r = result.validated;
  return (
    <div className="steps">
      <div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{r.title}</div>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
          {r.summary}
        </div>
        <div style={{ marginTop: 8 }}>
          {r.cues.map((c, i) => (
            <span className="tag" key={i}>{c}</span>
          ))}
        </div>
      </div>
      {r.steps.map((s, i) => (
        <div className="step" key={i}>
          <div className="title">{i + 1}. {s.title}</div>
          <div className="cue">{s.cue}</div>
          <div className="meta">
            {s.reps} reps · {s.durationSec}s
            {s.focusLandmark ? ` · ${s.focusLandmark}` : ""}
          </div>
        </div>
      ))}
      {result.sources.length > 0 && (
        <div>
          <div className="label" style={{ marginTop: 8 }}>Sources</div>
          {result.sources.slice(0, 4).map((s, i) => (
            <div key={i} style={{ fontSize: 12, marginTop: 4 }}>
              <a href={s} target="_blank" rel="noreferrer">{s}</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveTranscripts({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="label">Live transcript</div>
      {events.slice(-10).map((e, i) => {
        if (e.kind === "transcript") {
          return (
            <div key={i} style={{ fontSize: 13 }}>
              <span
                className="mono"
                style={{
                  color: e.role === "user" ? "var(--accent-2)" : "var(--accent)",
                  marginRight: 8,
                }}
              >
                {e.role}
              </span>
              {e.text}
            </div>
          );
        }
        if (e.kind === "toolCall") {
          return (
            <div key={i} className="mono" style={{ fontSize: 12, color: "var(--warn)" }}>
              tool {e.name}({JSON.stringify(e.args)})
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

function summarize(data: unknown): string {
  try {
    const s = JSON.stringify(data, null, 2);
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  } catch {
    return String(data);
  }
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function dotStyle(on: boolean): React.CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: on
      ? "linear-gradient(135deg, #7df9c4, #69b7ff)"
      : "var(--line-2)",
    display: "inline-block",
  };
}
