'use strict';
/**
 * Satisfactory Lightweight Query API (UDP, same port as the game, 1.0+).
 * Unauthenticated; returns server state, network changelist and server name.
 * Used to measure responsiveness and detect the running game version.
 */
const dgram = require('node:dgram');
const crypto = require('node:crypto');

const MAGIC = 0xF6D5;
const STATES = ['Offline', 'Idle', 'Loading', 'Playing'];

function buildPollRequest(cookie) {
  const b = Buffer.alloc(13);
  b.writeUInt16LE(MAGIC, 0);
  b.writeUInt8(0, 2); // PollServerState
  b.writeUInt8(1, 3); // protocol version
  b.writeBigUInt64LE(cookie, 4);
  b.writeUInt8(1, 12); // terminator
  return b;
}

function parseStateResponse(buf) {
  if (buf.length < 22) throw new Error('Query response too short');
  if (buf.readUInt16LE(0) !== MAGIC) throw new Error('Bad query magic');
  if (buf.readUInt8(2) !== 1) throw new Error('Unexpected query message type');
  let o = 4;
  const cookie = buf.readBigUInt64LE(o); o += 8;
  const state = buf.readUInt8(o); o += 1;
  const netCL = buf.readUInt32LE(o); o += 4;
  const flags = buf.readBigUInt64LE(o); o += 8;
  const numSub = buf.readUInt8(o); o += 1;
  const subStates = [];
  for (let i = 0; i < numSub && o + 3 <= buf.length; i++) {
    subStates.push({ id: buf.readUInt8(o), version: buf.readUInt16LE(o + 1) });
    o += 3;
  }
  let name = '';
  if (o + 2 <= buf.length) {
    const len = buf.readUInt16LE(o); o += 2;
    name = buf.slice(o, Math.min(o + len, buf.length)).toString('utf8');
  }
  return { cookie, state: STATES[state] || `Unknown(${state})`, stateCode: state, netCL, flags: Number(flags), subStates, name, protocolVersion: buf.readUInt8(3) };
}

function pollServerState(host, port, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const cookie = crypto.randomBytes(8).readBigUInt64LE(0);
    const started = Date.now();
    const timer = setTimeout(() => { sock.close(); reject(new Error('No response to UDP state query')); }, timeoutMs);
    sock.on('message', (msg) => {
      try {
        const res = parseStateResponse(msg);
        if (res.cookie !== cookie) return; // stale/foreign reply
        clearTimeout(timer); sock.close();
        resolve({ ...res, cookie: undefined, latencyMs: Date.now() - started });
      } catch (err) { clearTimeout(timer); sock.close(); reject(err); }
    });
    sock.on('error', (err) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } reject(err); });
    sock.send(buildPollRequest(cookie), port, host);
  });
}

module.exports = { pollServerState, buildPollRequest, parseStateResponse, STATES, MAGIC };
