/**
 * Ask a Mersennet node who it is over its public P2P TCP port.
 *
 * Wire format is the node's TcpSync framing: 4-byte big-endian length + JSON
 * GossipPacket { topic, data: number[], id, ttl }. We send topic "whoami" with
 * a 32-byte random nonce and expect "whoami_response" whose data is JSON:
 * { identity, operator, height, version, message, signature }. The message is
 * EIP-191 personal-sign formatted and signed by the node key, so
 * `ethers.verifyMessage` must recover `identity`, and the message must echo
 * our nonce (no replay).
 */
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { ethers } = require('ethers');

const DEFAULT_PORT = 30303;

function whoami(host, port = DEFAULT_PORT, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32);
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    const fail = (msg) => { clearTimeout(timer); sock.destroy(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail('node did not answer within 6s (is port 30303/tcp reachable?)'), timeoutMs);
    sock.on('connect', () => {
      const pkt = Buffer.from(JSON.stringify({ topic: 'whoami', data: [...nonce], id: '', ttl: 0 }));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(pkt.length);
      sock.write(Buffer.concat([len, pkt]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > 64 * 1024) return fail('oversized response');
      if (buf.length < 4 + len) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const packet = JSON.parse(buf.subarray(4, 4 + len).toString());
        if (packet.topic !== 'whoami_response') return reject(new Error(`unexpected response ${packet.topic}`));
        const body = JSON.parse(Buffer.from(packet.data).toString());
        if (!body.message || !body.signature || !body.identity) return reject(new Error('malformed attestation'));
        const recovered = ethers.verifyMessage(body.message, body.signature).toLowerCase();
        if (recovered !== String(body.identity).toLowerCase()) return reject(new Error('attestation signature does not match the node identity'));
        if (!body.message.includes(`nonce: ${nonce.toString('hex')}`)) return reject(new Error('attestation nonce mismatch (replay?)'));
        resolve({
          identity: recovered,
          operator: body.operator ? String(body.operator).toLowerCase() : null,
          height: Number(body.height) || 0,
          version: String(body.version || ''),
        });
      } catch (e) {
        reject(new Error(`bad attestation: ${e.message}`));
      }
    });
    sock.on('error', (e) => fail(`cannot reach ${host}:${port} (${e.code || e.message})`));
  });
}

module.exports = { whoami, DEFAULT_PORT };
