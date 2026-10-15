// OTLP/HTTP in, flat records out. Claude Code sends logs (its events) as http/json or
// http/protobuf; the Claude Platform sends traces as protobuf, gzipped. Both become the same
// list of { kind, name, ts, end, attrs, status, trace, span, parent } so one reader handles them.
// The protobuf side decodes only what OTLP logs and traces carry, by field number
// (opentelemetry-proto, collector/{logs,trace}/v1).
import { gunzipSync, inflateSync } from "node:zlib";

// --- protobuf wire format ------------------------------------------------------------------
function* fields(buf) {
  let i = 0;
  const varint = () => {
    let v = 0n, s = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("truncated varint");
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return v;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint()), no = tag >>> 3, wt = tag & 7;
    if (wt === 0) yield [no, wt, varint()];
    else if (wt === 1) { yield [no, wt, buf.subarray(i, i + 8)]; i += 8; }
    else if (wt === 2) { const n = Number(varint()); yield [no, wt, buf.subarray(i, i + n)]; i += n; }
    else if (wt === 5) { yield [no, wt, buf.subarray(i, i + 4)]; i += 4; }
    else throw new Error(`wire type ${wt}`);
  }
}
const u64 = (b) => Buffer.from(b).readBigUInt64LE(0);
const f64 = (b) => Buffer.from(b).readDoubleLE(0);
const utf8 = (b) => Buffer.from(b).toString("utf8");
const hex = (b) => Buffer.from(b).toString("hex");
const signed = (v) => BigInt.asIntN(64, v);

function anyValue(buf) {
  for (const [no, , v] of fields(buf)) {
    if (no === 1) return utf8(v);
    if (no === 2) return v !== 0n;
    if (no === 3) return Number(signed(v));
    if (no === 4) return f64(v);
    if (no === 5) return [...fields(v)].filter(([n]) => n === 1).map(([, , x]) => anyValue(x));
    if (no === 6) return Object.fromEntries([...fields(v)].filter(([n]) => n === 1).map(([, , x]) => keyValue(x)));
    if (no === 7) return hex(v);
  }
  return null;
}
function keyValue(buf) {
  let k = "", val = null;
  for (const [no, , v] of fields(buf)) { if (no === 1) k = utf8(v); else if (no === 2) val = anyValue(v); }
  return [k, val];
}
const attrsOf = (list) => Object.fromEntries(list.map(keyValue));
const resource = (buf) => attrsOf([...fields(buf)].filter(([n]) => n === 1).map(([, , v]) => v));

function pbLogs(buf) {
  const out = [];
  for (const [no, , rl] of fields(buf)) {
    if (no !== 1) continue;
    let res = {};
    const scopes = [];
    for (const [n, , v] of fields(rl)) { if (n === 1) res = resource(v); else if (n === 2) scopes.push(v); }
    for (const sl of scopes) for (const [n, , lr] of fields(sl)) {
      if (n !== 2) continue;
      const r = { kind: "log", res, attrs: [], ts: 0, body: null, event: "" };
      for (const [f, , v] of fields(lr)) {
        if (f === 1 || (f === 11 && !r.ts)) r.ts = Number(u64(v) / 1000000n);
        else if (f === 5) r.body = anyValue(v);
        else if (f === 6) r.attrs.push(v);
        else if (f === 9) r.trace = hex(v);
        else if (f === 10) r.span = hex(v);
        else if (f === 12) r.event = utf8(v);
      }
      out.push(logRecord(r.res, attrsOf(r.attrs), r.ts, r.body, r.event, r.trace, r.span));
    }
  }
  return out;
}
function pbTraces(buf) {
  const out = [];
  for (const [no, , rs] of fields(buf)) {
    if (no !== 1) continue;
    let res = {};
    const scopes = [];
    for (const [n, , v] of fields(rs)) { if (n === 1) res = resource(v); else if (n === 2) scopes.push(v); }
    for (const ss of scopes) for (const [n, , sp] of fields(ss)) {
      if (n !== 2) continue;
      const s = { attrs: [], status: { code: 0, message: "" } };
      for (const [f, , v] of fields(sp)) {
        if (f === 1) s.trace = hex(v);
        else if (f === 2) s.span = hex(v);
        else if (f === 4) s.parent = v.length ? hex(v) : "";
        else if (f === 5) s.name = utf8(v);
        else if (f === 7) s.start = Number(u64(v) / 1000000n);
        else if (f === 8) s.end = Number(u64(v) / 1000000n);
        else if (f === 9) s.attrs.push(v);
        else if (f === 15) for (const [g, , x] of fields(v)) { if (g === 2) s.status.message = utf8(x); else if (g === 3) s.status.code = Number(x); }
      }
      out.push({ kind: "span", name: s.name || "", ts: s.start || 0, end: s.end || 0, attrs: { ...res, ...attrsOf(s.attrs) }, status: s.status, trace: s.trace || "", span: s.span || "", parent: s.parent || "" });
    }
  }
  return out;
}

// --- OTLP/JSON -----------------------------------------------------------------------------
function jsonValue(v) {
  if (!v || typeof v !== "object") return v ?? null;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return !!v.boolValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(jsonValue);
  if ("kvlistValue" in v) return jsonAttrs(v.kvlistValue.values);
  if ("bytesValue" in v) return v.bytesValue;
  return null;
}
const jsonAttrs = (list) => Object.fromEntries((list || []).map((kv) => [kv.key, jsonValue(kv.value)]));
const ms = (nano) => (nano ? Math.floor(Number(BigInt(String(nano)) / 1000000n)) : 0);

function jsonLogs(d) {
  const out = [];
  for (const rl of d.resourceLogs || []) {
    const res = jsonAttrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs || []) for (const r of sl.logRecords || [])
      out.push(logRecord(res, jsonAttrs(r.attributes), ms(r.timeUnixNano) || ms(r.observedTimeUnixNano), jsonValue(r.body), r.eventName || "", r.traceId, r.spanId));
  }
  return out;
}
function jsonTraces(d) {
  const out = [];
  for (const rs of d.resourceSpans || []) {
    const res = jsonAttrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans || []) for (const s of ss.spans || [])
      out.push({ kind: "span", name: s.name || "", ts: ms(s.startTimeUnixNano), end: ms(s.endTimeUnixNano), attrs: { ...res, ...jsonAttrs(s.attributes) }, status: { code: Number(s.status?.code === "STATUS_CODE_ERROR" ? 2 : s.status?.code || 0), message: s.status?.message || "" }, trace: s.traceId || "", span: s.spanId || "", parent: s.parentSpanId || "" });
  }
  return out;
}

// A log record's name: OTel's event_name, Claude Code's event.name attribute, or its body.
function logRecord(res, attrs, ts, body, event, trace = "", span = "") {
  const name = String(event || attrs["event.name"] || (typeof body === "string" ? body : "")).replace(/^claude_code\./, "");
  return { kind: "log", name, ts: ts || Date.parse(attrs["event.timestamp"] || "") || Date.now(), end: 0, attrs: { ...res, ...attrs }, status: null, trace: trace || "", span: span || "", parent: "" };
}

// raw body + headers in, records out; throws on what it cannot read
export function decode(signal, raw, headers = {}) {
  const enc = String(headers["content-encoding"] || "").toLowerCase();
  const buf = enc === "gzip" ? gunzipSync(raw) : enc === "deflate" ? inflateSync(raw) : raw;
  const json = /json/.test(String(headers["content-type"] || ""));
  if (signal === "logs") return json ? jsonLogs(JSON.parse(buf.toString("utf8") || "{}")) : pbLogs(buf);
  if (signal === "traces") return json ? jsonTraces(JSON.parse(buf.toString("utf8") || "{}")) : pbTraces(buf);
  return [];
}
