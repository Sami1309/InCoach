import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, CompileResult, DrillVideo } from "@shared/types";
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
  const [stepIdx, setStepIdx] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [poseOn, setPoseOn] = useState(false);
  const [sway, setSway] = useState<number | null>(null);
  const swayRef = useRef<number | null>(null);
  const stopPoseRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [liveOn, setLiveOn] = useState(false);
  const [transcripts, setTranscripts] = useState<LiveEvent[]>([]);
  const liveRef = useRef<LiveSession | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const lastSwayPushRef = useRef(0);

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
    setStepIdx(0);
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
      (tick: PoseTick) => {
        swayRef.current = tick.swayScore;
        setSway(tick.swayScore);
      },
    );
    setPoseOn(true);
  };

  const buildSystem = (r: CompileResult | null) => {
    const base = `You are an encouraging ${sport} coach for the user's session: "${transcript}". Keep cues short (one breath), calm, corrective. If the user mentions pain, pause and recommend a safety screen. The user can interrupt you at any time.`;
    if (!r) return base;
    const lines = r.validated.steps
      .map((s, i) => `${i + 1}. ${s.title} — ${s.cue} (${s.reps}x, ${s.durationSec}s)`)
      .join("\n");
    return `${base}\nRoutine: ${r.validated.title}.\nSteps:\n${lines}\nWhen the user advances a step or you receive a [STATE] message, briefly call the new cue. Use [POSE] hints to coach posture in real time.`;
  };

  const startLive = async (r: CompileResult | null) => {
    if (liveRef.current) return;
    const session = new LiveSession({
      systemInstruction: buildSystem(r),
      onEvent: (e) => {
        setTranscripts((prev) => [...prev.slice(-40), e]);
        if (e.kind === "open") {
          session.sendText(
            r
              ? `Greet me briefly and tell me we're starting step 1: ${r.validated.steps[0]?.title}.`
              : "Greet me briefly and ask what we're working on today.",
          );
        }
      },
    });
    session.connect();
    liveRef.current = session;
    try {
      micRef.current = await startMicCapture((pcm) => session.sendAudio(pcm));
    } catch (err) {
      setTranscripts((prev) => [
        ...prev,
        {
          kind: "error",
          message: `Mic blocked: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }
    setLiveOn(true);
  };

  const stopLive = () => {
    micRef.current?.stop();
    micRef.current = null;
    liveRef.current?.close();
    liveRef.current = null;
    setLiveOn(false);
  };

  const toggleLive = async () => {
    if (liveOn) stopLive();
    else await startLive(result);
  };

  useEffect(() => {
    if (!result || !liveRef.current) return;
    const step = result.validated.steps[stepIdx];
    if (!step) return;
    liveRef.current.sendText(
      `[STATE] Now on step ${stepIdx + 1}/${result.validated.steps.length}: ${step.title}. Cue: ${step.cue}. Target ${step.reps} reps over ${step.durationSec}s.`,
    );
  }, [stepIdx, result]);

  useEffect(() => {
    if (!liveOn || !poseOn) return;
    const id = window.setInterval(() => {
      const s = swayRef.current;
      if (s == null || !liveRef.current) return;
      const now = Date.now();
      if (now - lastSwayPushRef.current < 2500) return;
      lastSwayPushRef.current = now;
      if (Math.abs(s) >= 2) {
        liveRef.current.sendText(
          `[POSE] sternum sway Δ ${s.toFixed(1)} ${s > 0 ? "right" : "left"} of baseline. Coach if drift exceeds 3.`,
        );
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [liveOn, poseOn]);

  const recall = () => {
    if (!recalled) return;
    setTranscript(recalled.transcript);
    setYoutubeUrl(recalled.youtubeUrl ?? "");
    setSport(recalled.sport);
    if (recalled.result) {
      setResult(recalled.result);
      setStepIdx(0);
    }
  };

  const platformLine = useMemo(() => {
    if (!result) return null;
    const intent = result.intent;
    return `${cap(intent.activity)} coach platform — first MVP: ${sport}. Compiles ${intent.durationMinutes}-min ${intent.skillLevel} routines from voice, validates them, finds video demos, and coaches live.`;
  }, [result, sport]);

  const steps = result?.validated.steps ?? [];
  const currentStep = steps[stepIdx];
  const videoForStep = (i: number): DrillVideo | undefined =>
    result?.videos.find((v) => v.stepIndex === i);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Coach Compiler
          <span className="sub mono">v0.1 · gemini-3.5-flash</span>
        </div>
        <div className="row">
          {recalled && (
            <button onClick={recall} title={`Saved ${timeAgo(recalled.savedAt)}`}>
              Recall last session
            </button>
          )}
          <button onClick={toggleLive}>
            {liveOn ? "Mute coach" : "Talk to coach"}
          </button>
          <span className={`pill ${liveOn ? "ok" : ""}`}>
            <span style={dotStyle(liveOn)} /> Live voice
          </span>
          <span className={`pill ${poseOn ? "ok" : ""}`}>
            <span style={dotStyle(poseOn)} /> Pose
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
              </div>
              {platformLine && (
                <div className="footer-line">{platformLine}</div>
              )}
            </div>
          </section>

          <section className="card" style={{ flex: 1 }}>
            <div className="card-header">
              <span className="card-title">Agent activity</span>
              <span
                className="mono"
                style={{ color: "var(--muted)", fontSize: 11 }}
              >
                {events.length} events
              </span>
            </div>
            <div className="card-body">
              {events.length === 0 ? (
                <div className="empty">
                  No agents running. Hit “Compile routine”.
                </div>
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
          <section className="card">
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
              {result && currentStep && (
                <DrillRunner
                  total={steps.length}
                  index={stepIdx}
                  title={currentStep.title}
                  cue={currentStep.cue}
                  reps={currentStep.reps}
                  durationSec={currentStep.durationSec}
                  video={videoForStep(stepIdx)}
                  onPrev={() => setStepIdx((i) => Math.max(0, i - 1))}
                  onNext={() =>
                    setStepIdx((i) => Math.min(steps.length - 1, i + 1))
                  }
                />
              )}
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
                <Routine
                  result={result}
                  stepIdx={stepIdx}
                  onSelect={(i) => setStepIdx(i)}
                />
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
  const cls = `event stage-${e.stage} status-${e.status}`;
  return (
    <div className={cls}>
      <div className="top">
        <span className="stage">
          {e.agent ?? e.stage}
          {e.model ? <span className="model"> · {e.model}</span> : null}
        </span>
        <span className="ts mono">{fmtTime(e.ts)}</span>
      </div>
      <div className="msg">{e.message}</div>
      {e.query && (
        <pre className="query">
          <span className="qmark">›</span> {truncate(e.query, 240)}
        </pre>
      )}
      {e.status === "result" && Boolean(e.data) && (
        <pre className="data">{summarize(e.data)}</pre>
      )}
    </div>
  );
}

function Routine({
  result,
  stepIdx,
  onSelect,
}: {
  result: CompileResult;
  stepIdx: number;
  onSelect: (i: number) => void;
}) {
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
            <span className="tag" key={i}>
              {c}
            </span>
          ))}
        </div>
      </div>
      {r.steps.map((s, i) => {
        const v = result.videos.find((x) => x.stepIndex === i);
        const active = i === stepIdx;
        return (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={`step ${active ? "active" : ""}`}
          >
            <div className="step-row">
              {v ? (
                <img src={v.thumb} alt="" className="step-thumb" />
              ) : (
                <div className="step-thumb placeholder" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">
                  {i + 1}. {s.title}
                </div>
                <div className="cue">{s.cue}</div>
                <div className="meta">
                  {s.reps} reps · {s.durationSec}s
                  {s.focusLandmark ? ` · ${s.focusLandmark}` : ""}
                </div>
              </div>
            </div>
          </button>
        );
      })}
      {result.sources.length > 0 && (
        <div>
          <div className="label" style={{ marginTop: 8 }}>
            Sources
          </div>
          {result.sources.slice(0, 4).map((s, i) => (
            <div key={i} style={{ fontSize: 12, marginTop: 4 }}>
              <a href={s} target="_blank" rel="noreferrer">
                {prettyUrl(s)}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DrillRunner({
  total,
  index,
  title,
  cue,
  reps,
  durationSec,
  video,
  onPrev,
  onNext,
}: {
  total: number;
  index: number;
  title: string;
  cue: string;
  reps: number;
  durationSec: number;
  video?: DrillVideo;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [t, setT] = useState<number | undefined>(video?.start);
  useEffect(() => {
    setT(video?.start);
  }, [video?.videoId, video?.start]);
  return (
    <div className="drill-runner">
      <div className="row between">
        <div>
          <div className="label">
            Step {index + 1} / {total}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>{cue}</div>
          <div className="meta" style={{ marginTop: 4 }}>
            {reps} reps · {durationSec}s
          </div>
        </div>
        <div className="row">
          <button onClick={onPrev} disabled={index === 0}>
            ←
          </button>
          <button
            className="primary"
            onClick={onNext}
            disabled={index >= total - 1}
          >
            Next step →
          </button>
        </div>
      </div>
      {video && (
        <>
          <div className="yt-embed">
            <iframe
              key={`${video.videoId}-${t ?? 0}`}
              src={`https://www.youtube.com/embed/${video.videoId}?rel=0&autoplay=0${t ? `&start=${t}` : ""}`}
              title="Drill demo"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          {video.moments && video.moments.length > 0 && (
            <div>
              <div className="label" style={{ marginTop: 6 }}>
                Key moments · validated by Gemini
              </div>
              <div className="moments">
                {video.moments.map((m, i) => (
                  <button
                    key={i}
                    className={`moment ${t === m.t ? "active" : ""}`}
                    onClick={() => setT(m.t)}
                    title={`Jump to ${fmtMmSs(m.t)}`}
                  >
                    <img src={m.thumb} alt="" />
                    <div className="ts mono">{fmtMmSs(m.t)}</div>
                    <div className="cap">{m.caption}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function fmtMmSs(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function LiveTranscripts({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 14,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div className="label">Live transcript</div>
      {events.slice(-12).map((e, i) => {
        if (e.kind === "transcript") {
          return (
            <div key={i} style={{ fontSize: 13 }}>
              <span
                className="mono"
                style={{
                  color:
                    e.role === "user" ? "var(--accent-2)" : "var(--accent)",
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
            <div
              key={i}
              className="mono"
              style={{ fontSize: 12, color: "var(--warn)" }}
            >
              tool {e.name}({JSON.stringify(e.args)})
            </div>
          );
        }
        if (e.kind === "info" || e.kind === "open" || e.kind === "close") {
          const text =
            e.kind === "info"
              ? e.text
              : e.kind === "open"
                ? "connected"
                : `disconnected ${e.reason ?? ""}`;
          return (
            <div
              key={i}
              className="mono"
              style={{ fontSize: 11, color: "var(--muted)" }}
            >
              · {text}
            </div>
          );
        }
        if (e.kind === "error") {
          return (
            <div
              key={i}
              className="mono"
              style={{ fontSize: 12, color: "var(--danger)" }}
            >
              {e.message}
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
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  } catch {
    return String(data);
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function prettyUrl(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
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
