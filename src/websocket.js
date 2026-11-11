import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal WebSocket server for the OpenAI Responses transport.
//
// Why this exists: the Codex client tries `ws://<base>/v1/responses` before it
// tries HTTPS. Declining that upgrade is not free -- Codex retries five times
// and burns ~16s of wall clock before falling back. It only probes WebSocket
// when the endpoint is the loopback `openai_base_url` provider, i.e. exactly
// the shape this bridge injects, so the cost landed on every single turn.
//
// The wire protocol is small: the client sends one text frame holding
// {"type":"response.create",...} with the same body it would POST, and expects
// the usual `response.*` events back, one JSON object per text frame. So the
// existing HTTPS path is reused unchanged: `streamResponses` writes SSE text
// into a shim that unpacks each "data: <json>" line and re-emits it as a frame.
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

// Server->client frames are never masked.
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeClose() {
  return Buffer.from([0x88, 0x00]);
}

// Returns { frames, rest } -- a masked client frame may be split across reads.
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2); head = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2)); head = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - off < head + maskLen + len) break;
    const payload = Buffer.from(buf.subarray(off + head + maskLen, off + head + maskLen + len));
    if (masked) {
      const mask = buf.subarray(off + head, off + head + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    off += head + maskLen + len;
    frames.push({ fin, opcode, payload });
  }
  return { frames, rest: buf.subarray(off) };
}

// A stand-in for http.ServerResponse that turns the SSE stream the HTTPS path
// already produces into WebSocket text frames.
function frameSink(socket, onDone) {
  const pending = [];
  let ended = false;
  const flushText = () => {
    if (pending.length === 1) {
      socket.write(encodeFrame(pending[0]));
    } else if (pending.length > 1) {
      socket.write(Buffer.concat(pending.map((p) => encodeFrame(p))));
    }
    pending.length = 0;
  };
  const sink = {
    __wbSeq: undefined,
    statusCode: 200,
    destroyed: false,
    get writableEnded() { return ended; },
    setHeader() {},
    flushHeaders() {},
    status() { return sink; },
    write(chunk) {
      if (ended || socket.destroyed) return true;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue; // drop "event:" lines
        const data = line.slice(6).trim();
        if (!data) continue;
        if (data === "[DONE]") continue; // terminal marker is SSE-only
        pending.push(data);
      }
      flushText();
      return true;
    },
    end() {
      ended = true;
      flushText();
      onDone?.();
    },
  };
  return sink;
}

/**
 * Handle a `ws://.../responses` upgrade from the Codex client.
 * `handleCreate(body, sink, signal)` is expected to run one turn and write the
 * response events into the sink; it may return a promise.
 */
export function attachWebSocketTransport(server, { log = () => {}, authorize, handleCreate, path: wsPath = "/v1/responses" } = {}) {
  server.on("upgrade", (req, socket) => {
    const urlPath = (req.url || "/").split("?")[0];
    if (urlPath !== wsPath && urlPath !== "/responses") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    if (authorize && !authorize(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    // Deliberately does not echo Sec-WebSocket-Extensions: without
    // permessage-deflate negotiated, every frame stays uncompressed.
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    log(`  ws transport accepted: ${urlPath}`);

    let buf = Buffer.alloc(0);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { socket.write(encodeClose()); } catch { /* peer already gone */ }
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) { close(); return; }
        if (frame.opcode === 0x9) { // ping -> pong
          const pong = Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]);
          socket.write(pong);
          continue;
        }
        if (frame.opcode !== 0x1) continue; // ignore binary/continuations
        let msg;
        try { msg = JSON.parse(frame.payload.toString("utf8")); }
        catch (e) { log(`  ! ws frame is not JSON: ${e.message}`); continue; }
        const sink = frameSink(socket, null);
        Promise.resolve()
          .then(() => handleCreate(msg, sink, undefined, req.headers))
          .catch((e) => {
            log(`  ! ws turn failed: ${e.message}`);
            if (!sink.writableEnded) {
              sink.write(`data: ${JSON.stringify({
                type: "response.failed", sequence_number: 0,
                response: {
                  id: `resp_${Date.now()}`, object: "response",
                  created_at: Math.floor(Date.now() / 1000), status: "failed",
                  model: msg.model || "", output: [],
                  error: { type: "server_error", code: e.code || "upstream_error", message: String(e.message || e).slice(0, 400) },
                  usage: null, incomplete_details: null,
                },
              })}\n\n`);
              sink.end();
            }
          });
      }
    });
    socket.on("error", () => { closed = true; });
    socket.on("close", () => { closed = true; });
  });
}

export const __test = { acceptKey, encodeFrame, decodeFrames, frameSink };
