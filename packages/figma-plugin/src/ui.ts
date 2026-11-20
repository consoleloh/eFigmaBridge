import type { HandshakeMessage, SessionInfo } from '@figmabridge/shared';

// SPEC 5.2.1: port range of the sessions and handshake version — same values in mcp-server/src/bridge.ts
const PORT_FIRST = 9323;
const PORT_LAST = 9325;
const PROTOCOL_VERSION = 2;

// SPEC 5.2.2: how often the range is scanned for sessions; also the reconnect delay (C2)
const SCAN_MS = 2_000;
// A port that does not answer the probe in this time has no session
const PROBE_TIMEOUT_MS = 1_000;

type SessionRef = { label: string; projectDir: string };
type Status = 'searching' | 'choose' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'rejected';

const select = document.getElementById('session') as HTMLSelectElement;
const dot = document.getElementById('dot') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;

let fileName = '';
let remembered: SessionRef | null = null;  // from clientStorage: the choice made for this file earlier
let target: SessionRef | null = null;      // session this run works with (chosen, attached or lost)
let sessions: SessionInfo[] = [];          // last scan result, by port
let ws: WebSocket | null = null;           // socket attached (or attaching) to a session
let wsPort: number | null = null;
let attached = false;
let status: Status = 'searching';
let rejectedBy = '';
let renderedOptions = '';                  // dropdown content last rendered
let generation = 0;                        // bumped on every attach / detach: a scan started before is stale

const sameSession = (a: SessionRef | null, b: SessionRef | null) =>
  !!a && !!b && a.label === b.label && a.projectDir === b.projectDir;
const refOf = (info: SessionInfo): SessionRef => ({ label: info.label, projectDir: info.projectDir });
const isFree = (info: SessionInfo) => info.busy === null || info.port === wsPort;

function setStatus(next: Status) {
  status = next;
  render();
}

function render() {
  const cls: Record<Status, string> = {
    searching: 'connecting', choose: 'connecting', connecting: 'connecting', connected: 'connected',
    reconnecting: 'reconnecting', closed: 'closed', rejected: 'closed',
  };
  dot.className = 'dot ' + cls[status];
  statusText.textContent =
    status === 'searching'    ? 'Поиск сессий…' :
    status === 'choose'       ? 'Выберите сессию' :
    status === 'connecting'   ? 'Connecting...' :
    status === 'connected'    ? 'Connected' :
    status === 'reconnecting' ? 'Reconnecting…' :
    status === 'closed'       ? 'Сессия закрыта' :
                                `Занята файлом «${rejectedBy}»`;

  // Dropdown: the label is visible, the value is the port; a session busy with another file is shown, not selectable
  const options = sessions.map((info) => ({
    value: String(info.port),
    text: isFree(info) ? info.label : `${info.label} — занята файлом «${info.busy}»`,
    disabled: !isFree(info),
  }));
  const signature = JSON.stringify(options);
  if (signature !== renderedOptions) {
    // Rebuilt only on change: a rebuild every scan would close the list the user has open
    renderedOptions = signature;
    select.textContent = '';
    const placeholder = new Option(sessions.length ? '— выберите сессию —' : 'Нет сессий', '');
    placeholder.disabled = true;
    select.add(placeholder);
    for (const o of options) {
      const option = new Option(o.text, o.value);
      option.disabled = o.disabled;
      select.add(option);
    }
  }
  const selected = sessions.find((info) => info.port === wsPort || (!wsPort && sameSession(refOf(info), target)));
  select.value = selected ? String(selected.port) : '';
}

// Only a label the agent set is worth remembering: a default label ("folder · time") changes every start
function remember(info: SessionInfo) {
  if (info.labelSource !== 'set') return;
  const ref = refOf(info);
  remembered = ref;
  parent.postMessage({ pluginMessage: { type: 'ui:remember', payload: ref } }, '*');
}

// Probe does not occupy the server (SPEC 5.2.1): ask for the info and close
function probe(port: number): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    let done = false;
    const socket = new WebSocket(`ws://localhost:${port}`);
    const finish = (info: SessionInfo | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(info && info.protocol === PROTOCOL_VERSION ? info : null);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'probe' }));
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as HandshakeMessage;
        finish(msg.type === 'info' ? msg.info : null);
      } catch {
        finish(null);
      }
    };
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

// One scan at a time: the next starts SCAN_MS after this one ends (a slow scan must not overlap the next)
async function scanLoop() {
  await scan();
  setTimeout(scanLoop, SCAN_MS);
}

// Ports are probed one by one from the first: servers take the first free port, so sessions sit at the
// start of the range. The browser opens WebSockets to one host one at a time (RFC 6455) and Windows refuses
// a closed localhost port only after about a second — probing all ten at once queued the attach behind
// the empty ports for tens of seconds. Two empty ports in a row end the scan; the session looked for
// (by label) ends it at once
async function scan() {
  // Attached or attaching — no scanning: the list stays as it was; scanning resumes after a drop or detach
  if (ws) return;
  const started = generation;
  const found: SessionInfo[] = [];
  let empty = 0;
  for (let p = PORT_FIRST; p <= PORT_LAST && empty < 2; p++) {
    const info = await probe(p);
    if (started !== generation) return; // attached or detached meanwhile — this result is stale
    if (!info) { empty++; continue; }
    empty = 0;
    found.push(info);
    const wanted = target ?? remembered;
    if (isFree(info) && sameSession(refOf(info), wanted)) break;
  }
  sessions = found;
  decide();
  render();
}

// Which session to attach to, when not attached (SPEC 5.2.2)
function decide() {
  if (ws) return; // attached or attaching
  if (target) {
    // Chosen or lost session: only the same one (by label), never another
    const match = sessions.find((s) => sameSession(refOf(s), target)) ?? restarted(target);
    if (match && isFree(match)) attach(match);
    else if (!match && status !== 'choose') setStatus('closed');
    else if (match && !isFree(match)) { rejectedBy = match.busy ?? ''; setStatus('rejected'); }
    return;
  }
  // Start of the run: the session remembered for this file, else the only free one
  const free = sessions.filter(isFree);
  const match = free.find((s) => sameSession(refOf(s), remembered)) ?? restarted(remembered);
  if (match) attach(match);
  else if (free.length === 1) attach(free[0]);
  else setStatus(sessions.length ? 'choose' : 'searching');
}

// Decision 2026-10-02: after a restart of Claude the session runs with a default label until the agent
// sets it on its first call to Figma. The only free session of the same project with a default label is
// taken for the lost one at once
function restarted(ref: SessionRef | null): SessionInfo | undefined {
  if (!ref) return undefined;
  const fresh = sessions.filter((s) => isFree(s) && s.labelSource === 'default' && s.projectDir === ref.projectDir);
  return fresh.length === 1 ? fresh[0] : undefined;
}

function detach() {
  generation++;
  const old = ws;
  ws = null;
  wsPort = null;
  attached = false;
  old?.close();
}

function attach(info: SessionInfo) {
  const port = info.port!;
  generation++;
  // A restarted session keeps the label it is reconnected for until the agent sets it
  if (info.labelSource === 'set' || !target) target = refOf(info);
  const socket = new WebSocket(`ws://localhost:${port}`);
  ws = socket;
  wsPort = port;
  attached = false;
  setStatus(status === 'reconnecting' ? 'reconnecting' : 'connecting');

  socket.onopen = () => socket.send(JSON.stringify({ type: 'attach', fileName }));

  socket.onmessage = (event: MessageEvent) => {
    let msg: { type?: string; requestId?: string; info?: SessionInfo };
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      console.error('[plugin-ui] failed to parse message:', event.data);
      return;
    }
    // RPC requests carry a requestId → forward to the sandbox
    if (msg.requestId) {
      // Binary arguments (SPEC 5.4.1): payload.bytesBase64 → payload.bytes (Uint8Array); atob() exists only here
      const payload = (msg as { payload?: { bytesBase64?: unknown } }).payload;
      if (payload && typeof payload.bytesBase64 === 'string') {
        const binary = atob(payload.bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        delete payload.bytesBase64;
        (payload as { bytes?: Uint8Array }).bytes = bytes;
      }
      if (attached) parent.postMessage({ pluginMessage: msg }, '*');
      return;
    }
    const hs = msg as HandshakeMessage;
    if (hs.type === 'attached' || hs.type === 'info') {
      // info on an attached socket = the label changed (set_session_label): follow it
      attached = true;
      generation++;
      if (hs.info.labelSource === 'set') target = refOf(hs.info);
      sessions = sessions.filter((s) => s.port !== port).concat(hs.info).sort((a, b) => a.port! - b.port!);
      remember(hs.info);
      setStatus('connected');
    } else if (hs.type === 'rejected') {
      // SPEC 5.2.5: busy with another file — refused, that file stays attached
      rejectedBy = hs.info.busy ?? '';
      if (ws === socket) detach();
      setStatus('rejected');
    }
  };

  socket.onerror = (event) => console.error('[plugin-ui] WebSocket error:', event);

  // C2 (SPEC 5.2.2): after a drop the next scans reconnect to the same session by label;
  // if it is gone — "Сессия закрыта", the choice is the user's
  socket.onclose = () => {
    if (ws !== socket) return; // replaced or detached on purpose
    const wasAttached = attached;
    detach();
    if (wasAttached) {
      console.log(`[plugin-ui] disconnected from port ${port} — reconnecting to «${target?.label}»`);
      setStatus('reconnecting');
    } else if (status !== 'rejected') {
      setStatus('reconnecting');
    }
  };
}

// The user picks a session in the dropdown
select.onchange = () => {
  const info = sessions.find((s) => String(s.port) === select.value);
  if (!info || !isFree(info) || info.port === wsPort) return;
  detach();
  status = 'connecting';
  target = refOf(info); // the user's choice replaces the session this run looked for
  attach(info);
};

// Messages from the sandbox: init with the file name and remembered choice, then RPC responses → mcp-server
window.onmessage = (event: MessageEvent) => {
  const response = event.data?.pluginMessage;
  if (!response) return;
  if (response.type === 'ui:init') {
    fileName = response.fileName;
    remembered = response.remembered;
    render();
    scanLoop();
    return;
  }
  if (ws && attached && ws.readyState === WebSocket.OPEN) {
    // Binary results: convert Uint8Array to base64 before JSON serialization.
    // btoa() is available here (browser/iframe context) but NOT in the Figma sandbox (main.ts).
    // Uint8Array passes natively through figma.ui.postMessage without serialization.
    // Chunks keep String.fromCharCode within the argument limit and avoid quadratic concatenation.
    if (response.result && response.result.data instanceof Uint8Array) {
      const bytes: Uint8Array = response.result.data;
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      response.result.data = btoa(binary);
    }
    ws.send(JSON.stringify(response));
  }
};

render();
