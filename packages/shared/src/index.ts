// Error codes shared by mcp-server and plugin (SPEC C1–C5)
export type BridgeErrorCode =
  | 'PORT_IN_USE'          // C1/5.2.1: every port of the range is held by other servers
  | 'PLUGIN_NOT_CONNECTED' // C3: plugin is not connected (or disconnected mid-request)
  | 'TIMEOUT'              // plugin did not answer in time
  | 'FIGMA_ERROR'          // C4: Figma API threw; message is the original text
  | 'UNKNOWN_REQUEST'      // plugin has no handler for the request type
  | 'NOT_FOUND'            // 3.2: no entity with the given id
  | 'INVALID_ARGUMENT';    // 3.2: arguments are invalid for the current file state; nothing was changed

// C5: single error format
export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

// WS message envelope — request sent from mcp-server to plugin
export interface RpcRequest {
  type: string;
  payload: unknown;
  requestId: string;
}

// SPEC 5.2.1: what a server tells the plugin about its session (probe and attach answers)
export interface SessionInfo {
  protocol: number;          // handshake version; the plugin ignores servers of another version
  port: number | null;
  label: string;             // shown in the plugin's session list
  labelSource: 'default' | 'set';
  projectDir: string;
  project: string;           // folder name of projectDir
  startedAt: string;         // ISO time the server started
  env: 'desktop' | 'cli';    // Claude Desktop or terminal Claude Code
  busy: string | null;       // name of the attached file, if any
}

// SPEC 5.2.1 handshake. Plugin → server: probe (does not occupy the server) or attach.
// Server → plugin: info (probe answer, label change), attached, rejected (busy with another file).
export type HandshakeMessage =
  | { type: 'probe' }
  | { type: 'attach'; fileName: string }
  | { type: 'info'; info: SessionInfo }
  | { type: 'attached'; info: SessionInfo }
  | { type: 'rejected'; info: SessionInfo };

// WS message envelope — response sent from plugin back to mcp-server
export interface RpcResponse {
  type: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}
