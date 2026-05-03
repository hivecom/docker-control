// Minecraft Query (UT3/GameSpy) protocol implementation.
// Protocol reference: https://minecraft.wiki/w/Query

export interface MinecraftQueryResult {
  // Player counts
  playerCount: number;
  maxPlayers: number;
  players: string[];
  // World
  world: string;
  // Server info
  motd: string;
  gameType: string;
  gameId: string;
  version: string;
  plugins: string;
  hostPort: number;
  hostIp: string;
  extra: Record<string, string>;
}

// Magic bytes for all client packets
const MAGIC = new Uint8Array([0xfe, 0xfd]);

// Packet type bytes
const TYPE_HANDSHAKE = 0x09;
const TYPE_STAT = 0x00;

// Fixed session ID - all 4 bytes, masked to lower nibbles (0x0F0F0F0F)
const SESSION_ID = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

const TIMEOUT_MS = 3000;

/**
 * Read a null-terminated string from a DataView starting at offset.
 * Returns the string and the new offset after the null byte.
 */
function readNullString(view: DataView, offset: number): [string, number] {
  const decoder = new TextDecoder("utf-8");
  let end = offset;
  while (end < view.byteLength && view.getUint8(end) !== 0) {
    end++;
  }
  const str = decoder.decode(
    new Uint8Array(view.buffer, view.byteOffset + offset, end - offset),
  );
  return [str, end + 1]; // skip null byte
}

/**
 * Build a handshake request packet.
 */
function buildHandshakeRequest(): Uint8Array {
  // Magic (2) + Type (1) + Session ID (4) = 7 bytes
  const buf = new Uint8Array(7);
  buf.set(MAGIC, 0);
  buf[2] = TYPE_HANDSHAKE;
  buf.set(SESSION_ID, 3);
  return buf;
}

/**
 * Build a full stat request packet using the challenge token.
 * Pads to 8 bytes of payload (challenge token + 4 zero bytes).
 */
function buildStatRequest(challengeToken: number): Uint8Array {
  // Magic (2) + Type (1) + Session ID (4) + Challenge token (4) + Padding (4) = 15 bytes
  const buf = new Uint8Array(15);
  const view = new DataView(buf.buffer);
  buf.set(MAGIC, 0);
  buf[2] = TYPE_STAT;
  buf.set(SESSION_ID, 3);
  view.setInt32(7, challengeToken, false); // big-endian
  // bytes 11-14 are zero padding - already zero from Uint8Array
  return buf;
}

/**
 * Parse a full stat response and extract player count, max players, and map.
 * Skips the 11-byte constant padding after the session ID, then reads K/V pairs.
 */
function parseFullStatResponse(
  data: Uint8Array,
): MinecraftQueryResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Response: Type (1) + Session ID (4) + 11-byte constant padding + K/V pairs
  if (data.length < 16 || view.getUint8(0) !== TYPE_STAT) {
    throw new Error("Invalid full stat response");
  }

  // Skip: type (1) + session ID (4) + 11-byte splitnum padding = offset 16
  let offset = 16;

  const kv: Record<string, string> = {};

  // Read K/V pairs until empty key
  while (offset < data.length) {
    const [key, afterKey] = readNullString(view, offset);
    offset = afterKey;
    if (key.length === 0) break;
    const [value, afterValue] = readNullString(view, offset);
    offset = afterValue;
    kv[key] = value;
  }

  const playerCount = parseInt(kv["numplayers"] ?? "0", 10);
  const maxPlayers = parseInt(kv["maxplayers"] ?? "0", 10);
  const hostPort = parseInt(kv["hostport"] ?? "0", 10);

  // Parse players section - follows a 10-byte constant padding after the K/V null terminator
  // Format: \x01player_\x00\x00 then null-terminated player names, terminated by empty string
  const players: string[] = [];
  const playerSectionMarker = new Uint8Array([
    0x01,
    0x70,
    0x6c,
    0x61,
    0x79,
    0x65,
    0x72,
    0x5f,
    0x00,
    0x00,
  ]);
  let playerOffset = -1;
  for (let i = offset; i <= data.length - playerSectionMarker.length; i++) {
    let match = true;
    for (let j = 0; j < playerSectionMarker.length; j++) {
      if (data[i + j] !== playerSectionMarker[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      playerOffset = i + playerSectionMarker.length;
      break;
    }
  }
  if (playerOffset !== -1) {
    let pos = playerOffset;
    while (pos < data.length) {
      const [name, afterName] = readNullString(view, pos);
      pos = afterName;
      if (name.length === 0) break;
      players.push(name);
    }
  }

  // Collect any remaining keys not already mapped into extra
  const knownKeys = new Set([
    "hostname",
    "gametype",
    "game_id",
    "version",
    "plugins",
    "map",
    "numplayers",
    "maxplayers",
    "hostport",
    "hostip",
  ]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(kv)) {
    if (!knownKeys.has(k)) extra[k] = v;
  }

  return {
    playerCount: isNaN(playerCount) ? 0 : playerCount,
    maxPlayers: isNaN(maxPlayers) ? 0 : maxPlayers,
    players,
    world: kv["map"] ?? "",
    motd: kv["hostname"] ?? "",
    gameType: kv["gametype"] ?? "",
    gameId: kv["game_id"] ?? "",
    version: kv["version"] ?? "",
    plugins: kv["plugins"] ?? "",
    hostPort: isNaN(hostPort) ? 0 : hostPort,
    hostIp: kv["hostip"] ?? "",
    extra,
  };
}

/**
 * Query a Minecraft server using the Query (UT3/GameSpy) protocol.
 * Performs a handshake to obtain the challenge token, then issues a full stat request.
 * Throws on failure or timeout.
 */
export async function queryMinecraft(
  host: string,
  port: number,
): Promise<MinecraftQueryResult> {
  const socket = Deno.listenDatagram({
    port: 0,
    hostname: "0.0.0.0",
    transport: "udp",
  });

  const remote: Deno.NetAddr = { transport: "udp", hostname: host, port };

  try {
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);

    const receive = async (): Promise<Uint8Array> => {
      const [data] = await Promise.race([
        socket.receive(),
        new Promise<never>((_, reject) => {
          timeoutSignal.addEventListener(
            "abort",
            () => reject(new Error("Minecraft query timed out")),
          );
        }),
      ]);
      return data;
    };

    // Step 1: Handshake - get challenge token
    await socket.send(buildHandshakeRequest(), remote);
    const handshakeResponse = await receive();

    // Handshake response: Type (1) + Session ID (4) + challenge token string (null-terminated)
    if (
      handshakeResponse.length < 6 ||
      handshakeResponse[0] !== TYPE_HANDSHAKE
    ) {
      throw new Error("Invalid handshake response");
    }

    const hsView = new DataView(
      handshakeResponse.buffer,
      handshakeResponse.byteOffset,
      handshakeResponse.byteLength,
    );
    const [tokenStr] = readNullString(hsView, 5); // skip type (1) + session ID (4)
    const challengeToken = parseInt(tokenStr, 10);

    if (isNaN(challengeToken)) {
      throw new Error(`Invalid challenge token string: "${tokenStr}"`);
    }

    // Step 2: Full stat request
    await socket.send(buildStatRequest(challengeToken), remote);
    const statResponse = await receive();

    return parseFullStatResponse(statResponse);
  } finally {
    socket.close();
  }
}
