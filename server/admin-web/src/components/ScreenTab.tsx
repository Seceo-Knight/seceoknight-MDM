import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, KeyboardEvent as RKeyboardEvent } from 'react';
import { useQuery, type useMutation } from '@tanstack/react-query';
import { deleteScreen, fetchTurnCredentials, listScreenRecordings, presignScreen, signalUrl, uploadScreenRecording } from '../api/screen';
import { useAuth } from '../stores/authStore';
import { useCan } from '../lib/rbac';
import { modeAllows, modeRequirement } from './DeviceMode';
import { Card, Button, Badge, Skeleton, cn } from './ui';
import { confirmDialog } from './confirm';
import { formatRelative } from './online';
import { MonitorSmartphone, Play, Square, ShieldHalf, Film, X, Trash2, Download, MousePointer2, Home, ArrowLeft, SquareStack, Power } from 'lucide-react';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// Keys whose default browser action (scroll / focus move / find) we swallow while
// the control surface is focused, even though we don't forward them to the device.
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Live screen mirror (WebRTC) + session recordings, Device-Owner only. The browser
 * is the answerer: it opens the /ws/signal relay, the agent (offerer) sends an SDP
 * offer, we answer and render the remote track in <video>. STOP ends the session;
 * the agent uploads the MP4 recording, which shows up in the list below.
 *
 * Two modes: "Share screen" (view-only) and "Control" (Phase 2). In control mode we
 * capture pointer/keyboard on the <video>, map to normalized [0,1] device coords,
 * and send {tap,swipe,key,text} over the agent's "control" data channel, which the
 * device replays via its accessibility service (dispatchGesture/performGlobalAction).
 */
export function ScreenTab({ deviceID, cmd, mode }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
  mode?: string | null;
}) {
  const token = useAuth(s => s.accessToken);
  const canView = useCan('command:issue:surveillance');
  const allowed = modeAllows(mode, 'screen_mirror');
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState<string | null>(null);
  const [control, setControl] = useState(false); // session is in remote-control mode
  const [kbActive, setKbActive] = useState(false); // control surface holds keyboard focus

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const runningRef = useRef(false);      // a session is meant to be live
  const startedRef = useRef(false);      // START was actually issued to the device
  const selfClosingRef = useRef(false);  // we initiated the WS close (suppress error)
  const keepaliveRef = useRef<number | null>(null); // ping timer (avoid idle-drop 1006)
  const recorderRef = useRef<MediaRecorder | null>(null); // in-browser session recorder
  const dcRef = useRef<RTCDataChannel | null>(null);      // Phase 2 control data channel
  const controlRef = useRef(false);                       // this session captures input
  const pointerRef = useRef<{ nx: number; ny: number; cx: number; cy: number; t: number } | null>(null);
  // Landscape detection: the agent always sends a portrait-shaped frame; when the
  // phone is landscape the content is a letterboxed band inside it. We detect that
  // (black bars top+bottom) and crop-to-fill so it doesn't sit as a small strip.
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lbPendingRef = useRef<boolean | null>(null);
  const lbCountRef = useRef(0);
  const [landscape, setLandscape] = useState(false);
  const [vdims, setVdims] = useState<{ w: number; h: number } | null>(null);

  const { data: recordings, refetch: refetchRecordings } = useQuery({
    queryKey: ['screen-recordings', deviceID],
    queryFn: () => listScreenRecordings(deviceID),
    refetchInterval: live ? 5000 : 20000,
  });

  // Record the received stream in the browser and upload it on stop — reliable
  // and it keeps a second encoder off the headless device (lower latency).
  function startRecording(stream: MediaStream) {
    if (recorderRef.current) return;
    try {
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const sid = sessionRef.current;
      const chunks: Blob[] = [];
      mr.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      mr.onstop = async () => {
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: mr.mimeType || 'video/webm' });
        const name = `screen_${sid ?? 'session'}_${chunks.length}.webm`;
        try { await uploadScreenRecording(blob, name, deviceID); refetchRecordings(); } catch { /* upload failed */ }
      };
      mr.start(2000); // flush a chunk every 2s so an abrupt end still leaves data
      recorderRef.current = mr;
    } catch { /* MediaRecorder unsupported — live view still works */ }
  }

  function wsSend(o: Record<string, unknown>) {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(o));
  }

  // Tear down local resources. issueStop sends STOP_SCREEN_SHARE only when a
  // session was actually started on the device — so a teardown during the
  // connecting phase (or an idle tab unmount) never fires a stray STOP.
  function teardown(issueStop: boolean) {
    selfClosingRef.current = true;
    if (keepaliveRef.current) { clearInterval(keepaliveRef.current); keepaliveRef.current = null; }
    if (issueStop && startedRef.current && sessionRef.current) {
      cmd.mutate({ kind: 'STOP_SCREEN_SHARE', payload: { session_id: sessionRef.current } });
    }
    startedRef.current = false;
    runningRef.current = false;
    sessionRef.current = null;
    controlRef.current = false;
    dcRef.current = null;
    pointerRef.current = null;
    setControl(false);
    // Stop the recorder first (while the stream is still live) so its onstop can
    // flush + upload the captured session.
    try { if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop(); } catch { /* ignore */ }
    recorderRef.current = null;
    try { pcRef.current?.close(); } catch { /* ignore */ }
    try { wsRef.current?.close(); } catch { /* ignore */ }
    pcRef.current = null; wsRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false); setStatus('Idle');
  }

  async function start(wantControl: boolean) {
    if (runningRef.current) return;
    runningRef.current = true;
    startedRef.current = false;
    selfClosingRef.current = false;
    controlRef.current = wantControl;
    setControl(wantControl);
    setError(null); setLive(true);
    try {
      setStatus('Fetching relay credentials…');
      const iceServers = await fetchTurnCredentials();
      if (!runningRef.current) return; // stopped while fetching
      const sessionId = `screen_${deviceID}_${Date.now()}`;
      sessionRef.current = sessionId;

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      pc.ontrack = e => {
        const stream = e.streams[0];
        if (videoRef.current) videoRef.current.srcObject = stream;
        // Minimize the receiver jitter buffer for low latency (LAN/real-time).
        try { (e.receiver as any).jitterBufferTarget = 0; } catch { /* not supported */ }
        startRecording(stream);
        setStatus('Live');
        // Grab keyboard focus so typing/keys land on the device, not the page.
        if (controlRef.current) requestAnimationFrame(() => videoRef.current?.focus());
      };
      pc.onicecandidate = e => {
        if (e.candidate) wsSend({ type: 'ice', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
      };
      // The agent (offerer) creates the "control" data channel; we receive it here
      // and send input over it when in control mode.
      pc.ondatachannel = e => { if (e.channel.label === 'control') dcRef.current = e.channel; };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') setStatus('Live');
        else if (s === 'failed' || s === 'disconnected') setStatus(`Peer ${s}`);
      };

      setStatus('Connecting to relay…');
      const ws = new WebSocket(signalUrl(deviceID), ['Bearer', token ?? '']);
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus('Starting capture on device…');
        // Hand the SAME ICE servers to the device so both sides use one relay.
        // record:false — recording is done in-browser now (no device-side encoder).
        cmd.mutate({ kind: 'START_SCREEN_SHARE', payload: { session_id: sessionId, record: false, ice_servers: iceServers } });
        startedRef.current = true;
        setStatus('Waiting for device…');
        // Keep the relay socket active so an intermediary doesn't idle-drop it
        // (1006) while we wait for the device's offer.
        keepaliveRef.current = window.setInterval(() => wsSend({ type: 'ping' }), 15000);
      };
      ws.onmessage = async ev => {
        const cur = pcRef.current;
        if (!cur) return;
        const msg = JSON.parse(ev.data);
        if (msg.type === 'offer') {
          await cur.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          const answer = await cur.createAnswer();
          await cur.setLocalDescription(answer);
          wsSend({ type: 'answer', sdp: answer.sdp });
        } else if (msg.type === 'ice' && msg.candidate) {
          try { await cur.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }); } catch { /* ignore late candidate */ }
        }
      };
      // Distinguish a close WE caused (silent) from an unexpected server/network
      // drop (surface the code so failures are diagnosable, not generic).
      ws.onerror = () => { if (!selfClosingRef.current) setStatus('Signaling error'); };
      ws.onclose = ev => {
        if (selfClosingRef.current) return;
        setStatus(`Disconnected (code ${ev.code})`);
        setError(`Signaling closed (code ${ev.code}${ev.reason ? ': ' + ev.reason : ''}). The relay or device dropped the connection.`);
        teardown(false);
      };
    } catch (e: any) {
      if (!selfClosingRef.current) setError(e?.message || 'Failed to start screen share');
      teardown(false);
    }
  }

  function stop() { teardown(true); }

  // Remote power-button: turn the device's screen back on. The mirror captures
  // only a rendering display, so the WebRTC feed goes black / dies when the
  // screen sleeps — this revives it without restarting the session. The tab is
  // already Device-Owner-gated (see modeAllows above), matching the agent side.
  function wake() { cmd.mutate({ kind: 'WAKE_DEVICE', payload: {} }); }

  // ---- Phase 2: input capture → control data channel ----

  function sendControl(o: Record<string, unknown>) {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify(o)); } catch { /* ignore */ } }
  }

  // Map a pointer position on the <video> to normalized [0,1] content coords,
  // accounting for object-contain letterboxing. Null if outside the content area.
  function normFromEvent(e: { clientX: number; clientY: number }): { nx: number; ny: number } | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const r = v.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const va = v.videoWidth / v.videoHeight, ea = r.width / r.height;
    let cw = r.width, ch = r.height, ox = 0, oy = 0;
    if (ea > va) { cw = r.height * va; ox = (r.width - cw) / 2; }
    else { ch = r.width / va; oy = (r.height - ch) / 2; }
    const nx = (e.clientX - r.left - ox) / cw, ny = (e.clientY - r.top - oy) / ch;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { nx, ny };
  }

  function onPointerDown(e: RPointerEvent) {
    if (!controlRef.current) return;
    const n = normFromEvent(e);
    if (!n) return;
    pointerRef.current = { nx: n.nx, ny: n.ny, cx: e.clientX, cy: e.clientY, t: Date.now() };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    (e.currentTarget as HTMLElement).focus();
  }

  function onPointerUp(e: RPointerEvent) {
    if (!controlRef.current) return;
    const start = pointerRef.current; pointerRef.current = null;
    if (!start) return;
    const end = normFromEvent(e) ?? { nx: start.nx, ny: start.ny };
    const dist = Math.hypot(e.clientX - start.cx, e.clientY - start.cy);
    const dt = Date.now() - start.t;
    if (dist < 12) sendControl({ type: 'tap', x: end.nx, y: end.ny });
    else sendControl({ type: 'swipe', x1: start.nx, y1: start.ny, x2: end.nx, y2: end.ny, ms: Math.min(Math.max(dt, 60), 1500) });
  }

  function onKeyDown(e: RKeyboardEvent) {
    if (!controlRef.current) return;
    // Keep every handled key away from the browser (scroll, quick-find, focus
    // change, history back) — the control surface owns the keyboard while focused.
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.ctrlKey || e.metaKey || e.altKey) return; // let real browser shortcuts through
    if (e.key === 'Backspace') { stop(); sendControl({ type: 'text', backspace: true }); }
    else if (e.key === 'Enter') { stop(); sendControl({ type: 'text', text: '\n' }); }
    else if (e.key.length === 1) { stop(); sendControl({ type: 'text', text: e.key }); }
    else if (NAV_KEYS.has(e.key)) { stop(); } // swallow so the page doesn't move/scroll
  }

  const globalKey = (action: 'home' | 'back' | 'recents') => {
    sendControl({ type: 'key', action });
    videoRef.current?.focus(); // keep keyboard capture after the button steals focus
  };

  // Stop the session if the operator truly leaves (component unmount). Guarded by
  // startedRef so a transient unmount mid-connect doesn't issue a stray STOP.
  useEffect(() => () => { teardown(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect a letterboxed (landscape) frame by sampling the video for black bars
  // top+bottom. Pure browser-side — no agent involvement. Requires 2 consecutive
  // consistent readings before flipping, to avoid flicker on a transient frame.
  useEffect(() => {
    // In control mode we keep object-contain (no crop) so pointer→device coordinate
    // mapping stays exact, so skip letterbox detection entirely.
    if (!live || control) { setLandscape(false); lbPendingRef.current = null; lbCountRef.current = 0; return; }
    const cv = detectCanvasRef.current ?? (detectCanvasRef.current = document.createElement('canvas'));
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      setVdims({ w: v.videoWidth, h: v.videoHeight });
      const W = 8, H = 100;
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      let d: Uint8ClampedArray;
      try { ctx.drawImage(v, 0, 0, W, H); d = ctx.getImageData(0, 0, W, H).data; } catch { return; }
      const rowBlack = (y: number) => {
        let s = 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; }
        return s / (W * 3) < 20;
      };
      let top = 0; while (top < H && rowBlack(top)) top++;
      let bot = H - 1; while (bot > top && rowBlack(bot)) bot--;
      const contentFrac = (bot - top + 1) / H;
      // Letterboxed landscape = substantial bars both ends + content band < ~82%.
      const lb = top / H > 0.08 && (H - 1 - bot) / H > 0.08 && contentFrac < 0.82 && contentFrac > 0.15;
      if (lbPendingRef.current === lb) lbCountRef.current++;
      else { lbPendingRef.current = lb; lbCountRef.current = 1; }
      if (lbCountRef.current >= 2) setLandscape(prev => (prev === lb ? prev : lb));
    }, 700);
    return () => clearInterval(id);
  }, [live, control]);

  // Capture wheel as a device scroll WITHOUT the page scrolling/zooming. React's
  // synthetic onWheel is passive (preventDefault is a no-op), so we attach a native
  // non-passive listener on the <video> for the duration of a control session.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !control || !live) return;
    const onWheelNative = (e: WheelEvent) => {
      if (!controlRef.current) return;
      e.preventDefault();           // always block page scroll / pinch-zoom / back-swipe
      if (e.ctrlKey) return;        // trackpad pinch — swallow it, don't map to a scroll
      const n = normFromEvent(e);
      if (!n) return;
      const d = Math.sign(e.deltaY) * 0.18;
      sendControl({ type: 'swipe', x1: n.nx, y1: clamp01(n.ny - d), x2: n.nx, y2: clamp01(n.ny + d), ms: 120 });
    };
    v.addEventListener('wheel', onWheelNative, { passive: false });
    return () => v.removeEventListener('wheel', onWheelNative);
  }, [control, live]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!allowed) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3 text-sm text-muted">
        <ShieldHalf className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <span><strong className="text-fg">Device Owner only.</strong> Live screen mirroring is available on fully-managed (Device Owner / Stealth) devices. {modeRequirement(mode, 'screen_mirror')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <MonitorSmartphone className="w-4 h-4 text-accent" />
          <span className="font-medium text-sm">Live screen</span>
          <Badge tone={live && status === 'Live' ? 'success' : live ? 'warn' : 'muted'} dot>{live ? status : 'Idle'}</Badge>
          {control && live && <Badge tone="info" dot>Control</Badge>}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" disabled={!canView}
                    title={canView ? 'Wake the device & turn the screen on (remote power button)' : 'Requires surveillance permission'}
                    onClick={wake}>
              <Power className="w-3.5 h-3.5" /> Wake
            </Button>
            {!live ? (
              <>
                <Button size="sm" variant="secondary" disabled={!canView} title={canView ? 'View-only live mirror' : 'Requires surveillance permission'} onClick={() => start(false)}>
                  <Play className="w-3.5 h-3.5" /> Share screen
                </Button>
                <Button size="sm" variant="primary" disabled={!canView} title={canView ? 'Live mirror + remote control' : 'Requires surveillance permission'} onClick={() => start(true)}>
                  <MousePointer2 className="w-3.5 h-3.5" /> Control
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={stop}><Square className="w-3.5 h-3.5" /> Stop</Button>
            )}
          </div>
        </div>
        <div className="bg-black grid place-items-center p-1" style={{ minHeight: live ? undefined : 320 }}>
          {/* ONE <video> kept mounted (so srcObject persists). Portrait → contain.
              Landscape (letterbox detected) → a landscape-aspect box with object-cover
              that crops the black bars so the content fills the width. The wrapper is
              always present; only its style + the video's fit change. */}
          <div style={live && landscape && vdims
            ? { width: '100%', aspectRatio: `${vdims.h} / ${vdims.w}`, maxHeight: '75vh', overflow: 'hidden' }
            : { display: live ? 'contents' : 'none' }}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} autoPlay playsInline muted
                   tabIndex={control ? 0 : undefined}
                   onPointerDown={control ? onPointerDown : undefined}
                   onPointerUp={control ? onPointerUp : undefined}
                   onPointerCancel={control ? () => { pointerRef.current = null; } : undefined}
                   onKeyDown={control ? onKeyDown : undefined}
                   onContextMenu={control ? (e => e.preventDefault()) : undefined}
                   onDragStart={control ? (e => e.preventDefault()) : undefined}
                   onFocus={control ? (() => setKbActive(true)) : undefined}
                   onBlur={control ? (() => setKbActive(false)) : undefined}
                   className={cn(
                     live && landscape ? 'w-full h-full' : 'max-h-[75vh] max-w-full w-auto h-auto',
                     control && kbActive && 'ring-2 ring-accent ring-inset',
                   )}
                   style={{ display: live ? 'block' : 'none', objectFit: live && landscape ? 'cover' : 'contain',
                            cursor: control ? 'crosshair' : undefined, outline: 'none',
                            touchAction: control ? 'none' : undefined,
                            overscrollBehavior: control ? 'none' : undefined,
                            userSelect: control ? 'none' : undefined, WebkitUserSelect: control ? 'none' : undefined }} />
          </div>
          {!live && <span className="text-faint text-sm py-16">Press <strong>Share screen</strong> to mirror, or <strong>Control</strong> to drive the device.</span>}
        </div>
        {control && live && (
          <div className="px-4 py-2 border-t border-line flex items-center gap-2">
            <MousePointer2 className={cn('w-3.5 h-3.5', kbActive ? 'text-accent' : 'text-faint')} />
            <span className="text-2xs text-faint">
              {kbActive
                ? 'Capturing input — click & drag to tap/swipe, type to send keys.'
                : 'Click the screen to capture mouse & keyboard.'}
            </span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="secondary" className="h-7" title="Back" onClick={() => globalKey('back')}><ArrowLeft className="w-3.5 h-3.5" /></Button>
              <Button size="sm" variant="secondary" className="h-7" title="Home" onClick={() => globalKey('home')}><Home className="w-3.5 h-3.5" /></Button>
              <Button size="sm" variant="secondary" className="h-7" title="Recents" onClick={() => globalKey('recents')}><SquareStack className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        )}
        {error && <div className="px-4 py-2 text-xs text-danger border-t border-line">{error}</div>}
        <div className="px-4 py-2 text-2xs text-faint border-t border-line">
          Capture starts silently on the managed device. The session is recorded for audit and saved under Session recordings when you Stop.
        </div>
      </Card>

      {/* Session recordings ("store what was done") */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <Film className="w-4 h-4 text-accent" />
          <span className="font-medium text-sm">Session recordings</span>
          <Badge tone="info" dot>{recordings?.length ?? 0}</Badge>
        </div>
        {recordings == null ? (
          <div className="px-4 py-6"><Skeleton className="h-5 w-full" /></div>
        ) : recordings.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-faint">No recordings yet — they appear here after a session ends.</div>
        ) : (
          <ul className="rail divide-y divide-line/70">
            {recordings.map(r => <RecordingRow key={r.id} id={r.id} name={r.name} sizeBytes={r.size_bytes} createdAt={r.created_at} onDeleted={() => refetchRecordings()} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RecordingRow({ id, name, sizeBytes, createdAt, onDeleted }: {
  id: string; name: string; sizeBytes: number; createdAt: string; onDeleted: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!(await confirmDialog({ title: 'Delete recording?', message: 'This permanently removes the saved session recording.', confirmLabel: 'Delete', icon: Trash2 }))) return;
    setBusy(true);
    try { await deleteScreen(id); onDeleted(); } finally { setBusy(false); }
  }
  async function download() {
    const { url } = await presignScreen(id);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Film className="w-4 h-4 text-faint shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{name}</div>
          <div className="text-2xs text-faint">{formatRelative(createdAt)} · {(sizeBytes / 1_000_000).toFixed(1)} MB</div>
        </div>
        {url
          ? <Button size="sm" variant="secondary" className="h-7" onClick={() => setUrl(null)}><X className="w-3.5 h-3.5" /> Close</Button>
          : <Button size="sm" variant="secondary" className="h-7" onClick={async () => setUrl((await presignScreen(id)).url)}><Play className="w-3.5 h-3.5" /> Play</Button>}
        <Button size="sm" variant="ghost" className="h-7" title="Download" onClick={download}><Download className="w-3.5 h-3.5" /></Button>
        <Button size="sm" variant="ghost" className="h-7 text-danger" disabled={busy} title="Delete recording" onClick={del}><Trash2 className="w-3.5 h-3.5" /></Button>
      </div>
      {url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={url} controls autoPlay className={cn('mt-2 w-full rounded-lg bg-black max-h-[50vh]')} />
      )}
    </li>
  );
}
