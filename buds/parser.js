/* Capture parser: Apple PacketLogger (.pklg) and Android btsnoop_hci.log.
   Extracts BLE ATT writes/notifications and classic RFCOMM (SPP) payloads. */
(function (root) {
  'use strict';

  const ATT = { 0x12: 'write', 0x52: 'write-cmd', 0x1b: 'notify', 0x1d: 'indicate', 0x0b: 'read-resp' };

  // ---- Container formats -> list of {ts(ms), dir:'tx'|'rx', acl:Uint8Array} ----
  function readBtsnoop(buf) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dlt = v.getUint32(12);
    const out = [];
    let o = 16;
    while (o + 24 <= buf.length) {
      const incl = v.getUint32(o + 4), flags = v.getUint32(o + 8);
      const tsHi = v.getUint32(o + 16), tsLo = v.getUint32(o + 20);
      const data = buf.subarray(o + 24, o + 24 + incl);
      o += 24 + incl;
      if (data.length < incl) break;
      const ts = (tsHi * 4294967296 + tsLo) / 1000; // µs -> ms (epoch 0 AD; only relative use)
      const dir = flags & 1 ? 'rx' : 'tx';
      if (dlt === 1002) { if (data[0] === 0x02) out.push({ ts, dir, acl: data.subarray(1) }); }
      else if (dlt === 1001) { if (!(flags & 2)) out.push({ ts, dir, acl: data }); }
    }
    return out;
  }

  function readPklg(buf) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Byte order differs between PacketLogger versions; pick the one whose first length is sane.
    const be = v.getUint32(0, false), le = v.getUint32(0, true);
    const little = !(be >= 9 && be <= buf.length - 4) || (le >= 9 && le <= buf.length - 4 && le < be);
    const out = [];
    let o = 0;
    while (o + 13 <= buf.length) {
      const len = v.getUint32(o, little);
      if (len < 9 || o + 4 + len > buf.length) break;
      const secs = v.getUint32(o + 4, little), usecs = v.getUint32(o + 8, little);
      const type = buf[o + 12];
      const data = buf.subarray(o + 13, o + 4 + len);
      o += 4 + len;
      const ts = secs * 1000 + usecs / 1000;
      if (type === 0x02) out.push({ ts, dir: 'tx', acl: data });
      else if (type === 0x03) out.push({ ts, dir: 'rx', acl: data });
    }
    return out;
  }

  function detect(buf) {
    const magic = String.fromCharCode(...buf.subarray(0, 7));
    return magic === 'btsnoop' ? 'btsnoop' : 'pklg';
  }

  // ---- ACL -> L2CAP reassembly ----
  function* l2capFrames(packets) {
    const pend = new Map(); // key conn+dir -> {ts, dir, buf, need}
    for (const p of packets) {
      if (p.acl.length < 4) continue;
      const hdr = p.acl[0] | (p.acl[1] << 8);
      const conn = hdr & 0x0fff, pb = (hdr >> 12) & 3;
      const body = p.acl.subarray(4);
      const key = conn + p.dir;
      if (pb === 1) { // continuation
        const st = pend.get(key); if (!st) continue;
        st.buf = concat(st.buf, body);
        if (st.buf.length >= st.need) { pend.delete(key); yield frame(st); }
        continue;
      }
      if (body.length < 4) continue;
      const need = (body[0] | (body[1] << 8)) + 4;
      const st = { ts: p.ts, dir: p.dir, conn, buf: body, need };
      if (body.length >= need) yield frame(st); else pend.set(key, st);
    }
    function frame(st) {
      const b = st.buf;
      return { ts: st.ts, dir: st.dir, conn: st.conn, cid: b[2] | (b[3] << 8), payload: b.subarray(4, st.need) };
    }
  }

  function concat(a, b) { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const uuidStr = b => {
    if (b.length === 2) return '0000' + (b[0] | (b[1] << 8)).toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
    const h = Array.from(b).reverse().map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  // ---- Main ----
  function parse(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    const format = detect(buf);
    const packets = format === 'btsnoop' ? readBtsnoop(buf) : readPklg(buf);
    const handleUuid = {};          // ATT value handle -> characteristic UUID
    const pendingRfcomm = {};       // conn -> {txCid, rxCid} once L2CAP PSM 3 is set up
    const sigReq = {};              // conn+ident -> host source CID for PSM 3
    const services = [];            // {start, end, uuid}
    const events = [];
    let t0 = null;

    for (const f of l2capFrames(packets)) {
      if (t0 === null) t0 = f.ts;
      const t = (f.ts - t0) / 1000;
      const p = f.payload;

      if (f.cid === 0x0004 && p.length) {               // ATT
        const op = p[0];
        if (op === 0x11 && p.length > 2) {              // Read By Group Type Response (primary services)
          const n = p[1];
          for (let i = 2; i + n <= p.length; i += n) {
            if (n === 6 || n === 20) services.push({ start: p[i] | (p[i + 1] << 8), end: p[i + 2] | (p[i + 3] << 8), uuid: uuidStr(p.subarray(i + 4, i + n)) });
          }
          continue;
        }
        if (op === 0x09 && p.length > 2) {              // Read By Type Response (characteristic discovery)
          const n = p[1];
          for (let i = 2; i + n <= p.length; i += n) {
            if (n === 7 || n === 21) {
              const valueHandle = p[i + 3] | (p[i + 4] << 8);
              handleUuid[valueHandle] = uuidStr(p.subarray(i + 5, i + n));
            }
          }
          continue;
        }
        if (ATT[op] && op !== 0x0b && p.length >= 3) {
          events.push({ t, dir: f.dir, kind: 'ble', op: ATT[op], handle: p[1] | (p[2] << 8), data: p.subarray(3) });
        }
        continue;
      }

      if (f.cid === 0x0001 && p.length >= 4) {          // L2CAP signalling: find RFCOMM channel
        const code = p[0], ident = p[1];
        if (code === 0x02 && p.length >= 8 && (p[4] | (p[5] << 8)) === 0x0003) {
          sigReq[f.conn + ':' + ident] = { from: f.dir, scid: p[6] | (p[7] << 8) };
        } else if (code === 0x03 && p.length >= 12) {
          const req = sigReq[f.conn + ':' + ident];
          const dcid = p[4] | (p[5] << 8), scid = p[6] | (p[7] << 8), result = p[8] | (p[9] << 8);
          if (req && result === 0) {
            // CID used by packets each side SENDS = the other side's local CID
            pendingRfcomm[f.conn] = req.from === 'tx' ? { tx: dcid, rx: scid } : { tx: scid, rx: dcid };
          }
        }
        continue;
      }

      const rc = pendingRfcomm[f.conn];
      if (rc && ((f.dir === 'tx' && f.cid === rc.tx) || (f.dir === 'rx' && f.cid === rc.rx)) && p.length >= 4) {
        const addr = p[0], ctrl = p[1], dlci = addr >> 2;
        if (dlci === 0 || (ctrl & 0xef) !== 0xef) continue;   // only UIH data frames
        let i = 2, len = p[i] >> 1;
        if (!(p[i] & 1)) { len |= p[i + 1] << 7; i++; }
        i++;
        if (ctrl & 0x10) i++;                                  // credit byte
        const data = p.subarray(i, i + len);
        if (data.length) events.push({ t, dir: f.dir, kind: 'spp', op: f.dir === 'tx' ? 'send' : 'recv', channel: dlci >> 1, data });
      }
    }

    const svcFor = h => (services.find(s => h >= s.start && h <= s.end) || {}).uuid || null;
    events.forEach(e => {
      e.hex = hex(e.data);
      e.uuid = e.kind === 'ble' ? handleUuid[e.handle] || null : null;
      e.service = e.kind === 'ble' ? svcFor(e.handle) : null;
    });

    // Group outgoing commands by identical bytes so repeated taps stand out.
    const groups = {};
    events.filter(e => e.dir === 'tx').forEach(e => {
      const k = e.kind + '|' + (e.handle ?? e.channel) + '|' + e.hex;
      (groups[k] = groups[k] || { kind: e.kind, handle: e.handle, channel: e.channel, uuid: e.uuid, service: e.service, hex: e.hex, times: [] }).times.push(e.t);
    });

    return { format, packets: packets.length, events, commands: Object.values(groups).sort((a, b) => a.times[0] - b.times[0]), handleUuid };
  }

  root.BudsCapture = { parse, hex };
  if (typeof module !== 'undefined') module.exports = root.BudsCapture;
})(typeof window !== 'undefined' ? window : globalThis);
