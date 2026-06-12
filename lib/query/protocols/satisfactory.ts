// Satisfactory Dedicated Server "Lightweight Query API" implementation.
// A simple request/response UDP protocol on the game port (default 7777).
// All multi-byte values are LITTLE ENDIAN.
//
// IMPORTANT: This protocol does NOT expose player counts. It only reports the
// server's run state and name. Player counts (numConnectedPlayers / playerLimit)
// are only available via the authenticated HTTPS API (QueryServerState), which
// requires a Bearer token and is handled separately.
//
// Protocol reference:
//   https://satisfactory.wiki.gg/wiki/Dedicated_servers/Lightweight_Query_API

export type SatisfactoryServerState =
  | "offline"
  | "idle"
  | "loading"
  | "playing"
  | "unknown";

export interface SatisfactoryQueryResult {
  // True when a response was received and successfully parsed.
  reachable: boolean;
  // True when a save is loaded and the server is joinable (state === playing).
  joinable: boolean;
  state: SatisfactoryServerState;
  serverName: string;
  // Game changelist the server runs; clients must match to connect.
  serverNetCL: number;
}

const TIMEOUT_MS = 3000;

const PROTOCOL_MAGIC = 0xf6d5;
const PROTOCOL_VERSION = 1;
const TERMINATOR_BYTE = 0x01;

const MESSAGE_POLL_SERVER_STATE = 0;
const MESSAGE_SERVER_STATE_RESPONSE = 1;

function stateFromEnum(value: number): SatisfactoryServerState {
  switch (value) {
    case 0:
      return "offline";
    case 1:
      return "idle";
    case 2:
      return "loading";
    case 3:
      return "playing";
    default:
      return "unknown";
  }
}

/**
 * Build a Poll Server State request envelope.
 * Layout (LE): magic(2) + type(1) + version(1) + cookie(8) + terminator(1) = 13.
 */
function buildPollRequest(cookie: bigint): Uint8Array {
  const buf = new Uint8Array(13);
  const view = new DataView(buf.buffer);
  view.setUint16(0, PROTOCOL_MAGIC, true);
  view.setUint8(2, MESSAGE_POLL_SERVER_STATE);
  view.setUint8(3, PROTOCOL_VERSION);
  view.setBigUint64(4, cookie, true);
  view.setUint8(12, TERMINATOR_BYTE);
  return buf;
}

/**
 * Parse a Server State Response envelope. Throws on malformed data or cookie
 * mismatch.
 */
function parseServerStateResponse(
  data: Uint8Array,
  expectedCookie: bigint,
): SatisfactoryQueryResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Envelope header: magic(2) + type(1) + version(1) = 4 bytes.
  if (data.length < 4) {
    throw new Error("Response too short");
  }
  if (view.getUint16(0, true) !== PROTOCOL_MAGIC) {
    throw new Error("Invalid protocol magic");
  }
  if (view.getUint8(2) !== MESSAGE_SERVER_STATE_RESPONSE) {
    throw new Error("Unexpected message type");
  }

  // Payload starts at offset 4.
  // cookie(8) + state(1) + netCL(4) + flags(8) + numSubStates(1) = 22 bytes.
  let offset = 4;
  if (offset + 22 > data.length) {
    throw new Error("Response payload too short");
  }

  const cookie = view.getBigUint64(offset, true);
  offset += 8;
  if (cookie !== expectedCookie) {
    throw new Error("Cookie mismatch");
  }

  const state = stateFromEnum(view.getUint8(offset));
  offset += 1;

  const serverNetCL = view.getUint32(offset, true);
  offset += 4;

  // ServerFlags (uint64 LE) - currently unused.
  offset += 8;

  const numSubStates = view.getUint8(offset);
  offset += 1;

  // Each sub state entry is 3 bytes: id(1) + version(2 LE). Skip them.
  offset += numSubStates * 3;

  if (offset + 2 > data.length) {
    throw new Error("Missing server name length");
  }
  const nameLength = view.getUint16(offset, true);
  offset += 2;

  let serverName = "";
  if (nameLength > 0 && offset + nameLength <= data.length) {
    serverName = new TextDecoder("utf-8").decode(
      new Uint8Array(data.buffer, data.byteOffset + offset, nameLength),
    );
  }

  return {
    reachable: true,
    joinable: state === "playing",
    state,
    serverName,
    serverNetCL,
  };
}

/**
 * Query a Satisfactory dedicated server via the Lightweight Query API.
 * Returns the server's run state and name. Throws on failure or timeout.
 */
export async function querySatisfactory(
  host: string,
  port: number,
): Promise<SatisfactoryQueryResult> {
  const socket = Deno.listenDatagram({
    port: 0,
    hostname: "0.0.0.0",
    transport: "udp",
  });

  const remote: Deno.NetAddr = { transport: "udp", hostname: host, port };

  // Unique per-request identifier echoed back by the server.
  const cookie = BigInt(Date.now());

  try {
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);

    const receive = async (): Promise<Uint8Array> => {
      const [data] = await Promise.race([
        socket.receive(),
        new Promise<never>((_, reject) => {
          timeoutSignal.addEventListener(
            "abort",
            () => reject(new Error("Satisfactory query timed out")),
          );
        }),
      ]);
      return data;
    };

    await socket.send(buildPollRequest(cookie), remote);
    const response = await receive();

    return parseServerStateResponse(response, cookie);
  } finally {
    socket.close();
  }
}
