// Source Engine A2S_INFO and A2S_PLAYER query protocol implementation.
// Protocol reference: https://developer.valvesoftware.com/wiki/Server_queries

export interface SourcePlayer {
  name: string;
  score: number;
  duration: number;
}

export interface SourceQueryResult {
  players: number;
  maxPlayers: number;
  map: string;
  playerList: SourcePlayer[] | null;
}

// A2S_INFO request payload: \xFF\xFF\xFF\xFFTSource Engine Query\0
const A2S_INFO_REQUEST = new Uint8Array([
  0xff,
  0xff,
  0xff,
  0xff,
  0x54,
  0x53,
  0x6f,
  0x75,
  0x72,
  0x63,
  0x65,
  0x20,
  0x45,
  0x6e,
  0x67,
  0x69,
  0x6e,
  0x65,
  0x20,
  0x51,
  0x75,
  0x65,
  0x72,
  0x79,
  0x00,
]);

const TIMEOUT_MS = 3000;
const RESPONSE_HEADER_CHALLENGE = 0x41;
const RESPONSE_HEADER_INFO = 0x49;
const RESPONSE_HEADER_PLAYER = 0x44;

// A2S_PLAYER initial request: \xFF\xFF\xFF\xFFU\xFF\xFF\xFF\xFF (challenge = -1)
const A2S_PLAYER_REQUEST = new Uint8Array([
  0xff,
  0xff,
  0xff,
  0xff,
  0x55,
  0xff,
  0xff,
  0xff,
  0xff,
]);

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
 * Build an A2S_PLAYER request with a known challenge number.
 */
function buildPlayerRequest(challenge: Uint8Array): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = 0xff;
  buf[1] = 0xff;
  buf[2] = 0xff;
  buf[3] = 0xff;
  buf[4] = 0x55;
  buf.set(challenge, 5);
  return buf;
}

/**
 * Parse A2S_PLAYER response. Returns null on malformed data.
 */
function parsePlayerResponse(data: Uint8Array): SourcePlayer[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Expect 0xFF 0xFF 0xFF 0xFF 0x44 header
  if (
    data.length < 6 ||
    view.getUint8(0) !== 0xff ||
    view.getUint8(1) !== 0xff ||
    view.getUint8(2) !== 0xff ||
    view.getUint8(3) !== 0xff ||
    view.getUint8(4) !== RESPONSE_HEADER_PLAYER
  ) {
    return null;
  }

  const count = view.getUint8(5);
  let offset = 6;
  const players: SourcePlayer[] = [];

  for (let i = 0; i < count; i++) {
    if (offset >= data.length) break;

    // Index byte
    offset += 1;

    // Name (null-terminated string)
    const [name, afterName] = readNullString(view, offset);
    offset = afterName;

    if (offset + 8 > data.length) break;

    // Score (int32 LE)
    const score = view.getInt32(offset, true);
    offset += 4;

    // Duration (float32 LE)
    const duration = view.getFloat32(offset, true);
    offset += 4;

    players.push({ name, score, duration });
  }

  return players;
}

/**
 * Query A2S_PLAYER on its own socket. Returns null on any failure.
 */
async function querySourcePlayers(
  host: string,
  port: number,
): Promise<SourcePlayer[] | null> {
  const socket = Deno.listenDatagram({
    port: 0,
    hostname: "0.0.0.0",
    transport: "udp",
  });

  const remote: Deno.NetAddr = { transport: "udp", hostname: host, port };

  try {
    await socket.send(A2S_PLAYER_REQUEST, remote);

    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
    const receive = async (): Promise<Uint8Array> => {
      const [data] = await Promise.race([
        socket.receive(),
        new Promise<never>((_, reject) => {
          timeoutSignal.addEventListener(
            "abort",
            () => reject(new Error("A2S_PLAYER timed out")),
          );
        }),
      ]);
      return data;
    };

    let response = await receive();

    // Server sent a challenge response (0x41) - reply with the challenge
    if (
      response.length >= 9 &&
      response[4] === RESPONSE_HEADER_CHALLENGE
    ) {
      const challenge = response.slice(5, 9);
      await socket.send(buildPlayerRequest(challenge), remote);
      response = await receive();
    }

    return parsePlayerResponse(response);
  } catch {
    return null;
  } finally {
    socket.close();
  }
}

/**
 * Parse A2S_INFO response buffer (starting after the 4x\xFF header bytes).
 * Buffer should start with the 0x49 byte.
 */
function parseInfoResponse(
  data: Uint8Array,
): Omit<SourceQueryResult, "playerList"> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Expect 0xFF 0xFF 0xFF 0xFF 0x49 header
  if (
    view.getUint8(0) !== 0xff ||
    view.getUint8(1) !== 0xff ||
    view.getUint8(2) !== 0xff ||
    view.getUint8(3) !== 0xff ||
    view.getUint8(4) !== RESPONSE_HEADER_INFO
  ) {
    throw new Error("Invalid A2S_INFO response header");
  }

  let offset = 5;

  // Protocol byte
  offset += 1;

  // Name (server name)
  const [, afterName] = readNullString(view, offset);
  offset = afterName;

  // Map
  const [map, afterMap] = readNullString(view, offset);
  offset = afterMap;

  // Folder
  const [, afterFolder] = readNullString(view, offset);
  offset = afterFolder;

  // Game
  const [, afterGame] = readNullString(view, offset);
  offset = afterGame;

  // Steam App ID (int16 LE)
  offset += 2;

  // Player counts
  const players = view.getUint8(offset++);
  const maxPlayers = view.getUint8(offset++);

  return { players, maxPlayers, map };
}

/**
 * Query a Source Engine game server using A2S_INFO and A2S_PLAYER in parallel.
 * A2S_INFO failure throws. A2S_PLAYER failure yields playerList: null.
 */
export async function querySource(
  host: string,
  port: number,
): Promise<SourceQueryResult> {
  const socket = Deno.listenDatagram({
    port: 0,
    hostname: "0.0.0.0",
    transport: "udp",
  });

  const remote: Deno.NetAddr = { transport: "udp", hostname: host, port };

  try {
    // Send initial A2S_INFO request
    await socket.send(A2S_INFO_REQUEST, remote);

    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);

    const receive = async (): Promise<Uint8Array> => {
      const [data] = await Promise.race([
        socket.receive(),
        new Promise<never>((_, reject) => {
          timeoutSignal.addEventListener(
            "abort",
            () => reject(new Error("Query timed out")),
          );
        }),
      ]);

      return data;
    };

    let responseData = await receive();

    // Check if this is a challenge response (0xFF FF FF FF 0x41)
    if (
      responseData.length >= 9 &&
      responseData[0] === 0xff &&
      responseData[1] === 0xff &&
      responseData[2] === 0xff &&
      responseData[3] === 0xff &&
      responseData[4] === RESPONSE_HEADER_CHALLENGE
    ) {
      // Extract the 4-byte challenge number
      const challenge = responseData.slice(5, 9);

      // Build new request with challenge appended
      const challengeRequest = new Uint8Array(
        A2S_INFO_REQUEST.length + challenge.length,
      );
      challengeRequest.set(A2S_INFO_REQUEST);
      challengeRequest.set(challenge, A2S_INFO_REQUEST.length);

      await socket.send(challengeRequest, remote);

      // Receive the actual info response
      responseData = await receive();
    }

    const [info, playerList] = await Promise.all([
      parseInfoResponse(responseData),
      querySourcePlayers(host, port),
    ]);

    return { ...info, playerList };
  } finally {
    socket.close();
  }
}
