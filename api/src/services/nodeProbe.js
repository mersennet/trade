/**
 * Ask a Mersennet node who it is over its public P2P TCP port.
 *
 * Wire format is the node's TcpSync framing: 4-byte big-endian length + JSON
 * GossipPacket { topic, data: number[] | base64 string, id, ttl }. We send topic "whoami" with
 * a 32-byte random nonce and expect "whoami_response" whose data is JSON:
 * { identity, operator, height, version, message, signature }. The message is
 * EIP-191 personal-sign formatted and signed by the node key, so
 * `ethers.verifyMessage` must recover `identity`, and the message must echo
 * our nonce (no replay).
 */
const net = require('node:net');
const dns = require('node:dns').promises;
const { randomBytes } = require('node:crypto');
const { ethers } = require('ethers');

const DEFAULT_PORT = 30303;

// Never dialled: this host's loopback, private and shared networks, link-local
// (cloud metadata), documentation, benchmarking, multicast and reserved space.
// BlockList checks IPv4-mapped IPv6 addresses against the IPv4 rules.
const NOT_PUBLIC = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NOT_PUBLIC.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) NOT_PUBLIC.addSubnet(a, p, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Resolve `host` as the connection would (the resolver also reads numeric
 * forms such as 2130706433 or 0x7f000001, and /etc/hosts names in any case)
 * and return the address to dial. Every resolved address must be public; the
 * caller dials the returned address, never the name, so a second lookup
 * cannot answer differently.
 */
async function resolvePublic(host) {
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`cannot resolve ${host} (${e.code || e.message})`);
  }
  if (!records.length || records.some((r) => !isPublicAddress(r.address))) {
    throw new Error('host must resolve to a public IP address');
  }
  return records[0];
}

async function whoami(host, port = DEFAULT_PORT, timeoutMs = 6000) {
  const target = await resolvePublic(host);
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32);
    const sock = net.createConnection({ host: target.address, port, family: target.family });
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
        // Nodes send `data` as a JSON byte array (legacy) or a base64 string
        // (compact wire format, from block 1,440,000); accept both.
        const raw = typeof packet.data === 'string' ? Buffer.from(packet.data, 'base64') : Buffer.from(packet.data);
        const body = JSON.parse(raw.toString());
        if (!body.message || !body.signature || !body.identity) return reject(new Error('malformed attestation'));
        const recovered = ethers.verifyMessage(body.message, body.signature).toLowerCase();
        if (recovered !== String(body.identity).toLowerCase()) return reject(new Error('attestation signature does not match the node identity'));
        if (!body.message.includes(`nonce: ${nonce.toString('hex')}`)) return reject(new Error('attestation nonce mismatch (replay?)'));
        resolve({
          identity: recovered,
          operator: body.operator ? String(body.operator).toLowerCase() : null,
          height: Number(body.height) || 0,
          version: String(body.version || ''),
          // Node-key signature over "operator+identity": the proof the staking
          // precompile's registerValidator() checks. Static per node config.
          registrationProof: typeof body.registrationProof === 'string' && /^0x[0-9a-f]{130}$/i.test(body.registrationProof) ? body.registrationProof : null,
        });
      } catch (e) {
        reject(new Error(`bad attestation: ${e.message}`));
      }
    });
    sock.on('error', (e) => fail(`cannot reach ${host}:${port} (${e.code || e.message})`));
  });
}

module.exports = { whoami, resolvePublic, isPublicAddress, DEFAULT_PORT };
