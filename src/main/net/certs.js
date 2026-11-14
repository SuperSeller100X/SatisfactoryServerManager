'use strict';
/**
 * Self-signed TLS certificate (ECDSA P-256 / SHA-256) for the local web
 * dashboard and remote management endpoint, generated with a minimal DER
 * encoder so no third-party crypto dependency is needed. Clients pin the
 * SHA-256 fingerprint shown in the UI.
 */
const crypto = require('node:crypto');
const net = require('node:net');

const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => { let b = Buffer.from(buf); while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const oid = (s) => {
  const parts = s.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let x = p >> 7;
    while (x > 0) { stack.unshift(0x80 | (x & 0x7f)); x >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const utcTime = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octet = (buf) => tlv(0x04, buf);
const explicit = (n, body) => tlv(0xa0 + n, body);

function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  // IPv6: expand '::'
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.concat(groups.map((g) => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(g || '0', 16)); return b; }));
}

function generateCertificate({ commonName = 'Satisfactory Server Manager', hosts = ['localhost', '127.0.0.1'], days = 825 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const now = new Date(Date.now() - 5 * 60000);
  const until = new Date(now.getTime() + days * 86400000);
  const san = Buffer.concat(hosts.map((h) => (net.isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, 'ascii')))));
  const extensions = seq(
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octet(seq())),                // basicConstraints CA:false (critical)
    seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), octet(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage digitalSignature
    seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.1')))),                       // extKeyUsage serverAuth
    seq(oid('2.5.29.17'), octet(seq(san))),                                              // subjectAltName
  );
  const tbs = seq(explicit(0, int(Buffer.from([2]))), int(crypto.randomBytes(16)), sigAlg, name, seq(utcTime(now), utcTime(until)), name, spki, explicit(3, extensions));
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, sigAlg, bitString(signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const x = new crypto.X509Certificate(certPem);
  return { certPem, keyPem, fingerprint: x.fingerprint256, validTo: x.validTo, hosts };
}

module.exports = { generateCertificate };
