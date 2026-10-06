import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';

const PROTOCOL_1_20_1 = 763;

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function mcString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
}

function packet(id, payload) {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
}

/** Lit un VarInt ; renvoie null si le buffer est incomplet. */
function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt invalide');
  }
}

/** Résout un éventuel enregistrement SRV (_minecraft._tcp). */
async function resolveTarget(host, port) {
  if (port !== 25565 || net.isIP(host)) return { host, port };
  try {
    const [srv] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (srv) return { host: srv.name, port: srv.port };
  } catch {
    /* pas de SRV */
  }
  return { host, port };
}

/** Server List Ping (le même que l'écran Multijoueur de Minecraft). */
export async function ping(host, port = 25565, timeout = 5000) {
  const target = await resolveTarget(host, port);
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    let buf = Buffer.alloc(0);
    let status = null;
    let pingSentAt = 0;
    const fail = (e) => {
      socket.destroy();
      reject(e);
    };
    socket.setTimeout(timeout, () => fail(new Error('Délai dépassé')));
    socket.on('error', fail);
    socket.on('connect', () => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port);
      socket.write(packet(0x00, Buffer.concat([varint(PROTOCOL_1_20_1), mcString(host), p, varint(1)])));
      socket.write(packet(0x00, Buffer.alloc(0)));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (true) {
          const len = readVarint(buf, 0);
          if (!len || buf.length < len.size + len.value) return;
          const body = buf.subarray(len.size, len.size + len.value);
          buf = buf.subarray(len.size + len.value);
          const id = readVarint(body, 0);
          if (id.value === 0x00 && !status) {
            const sl = readVarint(body, id.size);
            status = JSON.parse(body.subarray(id.size + sl.size, id.size + sl.size + sl.value).toString('utf8'));
            pingSentAt = Date.now();
            const payload = Buffer.alloc(8);
            payload.writeBigInt64BE(BigInt(pingSentAt));
            socket.write(packet(0x01, payload));
          } else if (id.value === 0x01) {
            socket.end();
            resolve({ ...status, latency: Date.now() - pingSentAt });
          }
        }
      } catch (e) {
        fail(e);
      }
    });
    socket.on('close', () => {
      // Certains serveurs ferment sans répondre au ping : on garde le statut.
      if (status) resolve({ ...status, latency: null });
      // Un proxy peut accepter la connexion puis la fermer quand le serveur est éteint.
      else reject(new Error('Connexion fermée sans réponse'));
    });
  });
}

/**
 * Protocole Query (UDP, enable-query=true dans server.properties) :
 * donne la liste complète des joueurs, contrairement au ping limité à 12 noms.
 */
export function query(host, port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const session = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('Query : délai dépassé'));
    }, timeout);
    const done = (fn, v) => {
      clearTimeout(timer);
      sock.close();
      fn(v);
    };
    sock.on('error', (e) => done(reject, e));
    sock.on('message', (msg) => {
      if (msg[0] === 0x09) {
        const token = parseInt(msg.subarray(5).toString('latin1').replace(/\0+$/, ''), 10);
        const t = Buffer.alloc(4);
        t.writeInt32BE(token);
        sock.send(Buffer.concat([Buffer.from([0xfe, 0xfd, 0x00]), session, t, Buffer.alloc(4)]), port, host);
      } else if (msg[0] === 0x00) {
        // Réponse complète : 11 octets de remplissage, paires clé/valeur, puis la liste des joueurs.
        const text = msg.subarray(16).toString('utf8');
        const [kvPart, playersPart = ''] = text.split('\x00\x01player_\x00\x00');
        const kv = kvPart.split('\x00');
        const info = {};
        for (let i = 0; i + 1 < kv.length; i += 2) if (kv[i]) info[kv[i]] = kv[i + 1];
        const players = playersPart.split('\x00').filter(Boolean);
        done(resolve, { info, players });
      }
    });
    sock.send(Buffer.concat([Buffer.from([0xfe, 0xfd, 0x09]), session]), port, host);
  });
}

/** Convertit une description (texte ou composant JSON) en texte avec codes §. */
export function flattenMotd(desc) {
  if (desc == null) return '';
  if (typeof desc === 'string') return desc;
  const COLORS = {
    black: '0',
    dark_blue: '1',
    dark_green: '2',
    dark_aqua: '3',
    dark_red: '4',
    dark_purple: '5',
    gold: '6',
    gray: '7',
    dark_gray: '8',
    blue: '9',
    green: 'a',
    aqua: 'b',
    red: 'c',
    light_purple: 'd',
    yellow: 'e',
    white: 'f',
  };
  let out = '';
  const walk = (c) => {
    if (typeof c === 'string') {
      out += c;
      return;
    }
    if (c.color && COLORS[c.color]) out += `§${COLORS[c.color]}`;
    if (c.bold) out += '§l';
    if (c.italic) out += '§o';
    out += c.text ?? '';
    for (const e of c.extra ?? []) walk(e);
    if (c.color || c.bold || c.italic) out += '§r';
  };
  walk(desc);
  return out;
}

/** Statut agrégé du serveur pour l'interface. */
export async function getServerStatus({ host, port, queryPort }) {
  try {
    const s = await ping(host, port);
    let players = (s.players?.sample ?? []).map((p) => ({ name: p.name, uuid: p.id }));
    let complete = (s.players?.online ?? 0) <= players.length;
    if (queryPort) {
      try {
        const q = await query(host, queryPort);
        const byName = new Map(players.map((p) => [p.name, p]));
        players = q.players.map((name) => byName.get(name) ?? { name, uuid: null });
        complete = true;
      } catch {
        /* Query désactivé : on garde l'échantillon du ping */
      }
    }
    // Certains serveurs masquent les joueurs avec un faux échantillon (UUID nul).
    players = players.filter((p) => p.uuid !== '00000000-0000-0000-0000-000000000000');
    return {
      online: true,
      checkedAt: Date.now(),
      motd: flattenMotd(s.description),
      version: s.version?.name ?? '',
      protocol: s.version?.protocol ?? null,
      playersOnline: s.players?.online ?? 0,
      playersMax: s.players?.max ?? 0,
      players: players.sort((a, b) => a.name.localeCompare(b.name)),
      playersComplete: complete,
      favicon: s.favicon ?? null,
      latency: s.latency,
    };
  } catch (e) {
    return { online: false, checkedAt: Date.now(), error: e.message };
  }
}
