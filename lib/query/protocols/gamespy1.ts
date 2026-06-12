// GameSpy v1 (text) query protocol implementation.
// Used by Unreal Tournament '99 (UT99) and Unreal Tournament 2004 (UT2004),
// and many other GameSpy-era titles.
//
// NOTE: This is the *legacy text* GameSpy protocol (backslash-delimited
// key/value pairs), NOT the newer binary GameSpy protocol used by UT3/Minecraft
// (see minecraft.ts). The two are not interchangeable.
//
// Protocol reference:
//   https://www.mobile-infanterie.de/wiki/doku.php?id=en:games:ut99:query_protocol
//
// The query is sent to the server's QUERY port (for UT99 this is the game port
// + 1, e.g. game 7777 -> query 7778; for UT2004 it is configurable). The caller
// is responsible for supplying the correct query port.

export interface GameSpyPlayer {
  name: string;
  frags: number | null;
  ping: number | null;
  team: string | null;
}

export interface GameSpyQueryResult {
  numPlayers: number;
  maxPlayers: number;
  map: string;
  hostName: string;
  gameType: string;
  players: GameSpyPlayer[];
  // Any key/value pairs not mapped above (e.g. mutators, version, etc.)
  extra: Record<string, string>;
}

const TIMEOUT_MS = 3000;

// `\status\` asks the server for basic + info + rules + players in one go.
const STATUS_REQUEST = new TextEncoder().encode("\\status\\");

/**
 * Parse a backslash-delimited GameSpy v1 payload into key/value pairs.
 * Format: \key1\value1\key2\value2\...
 * Control markers (queryid, final) are skipped by the caller before parsing.
 */
function parseKeyValues(payload: string): Record<string, string> {
  // Leading backslash produces an empty first token, which we discard.
  const tokens = payload.split("\\");
  const start = tokens.length > 0 && tokens[0] === "" ? 1 : 0;

  const kv: Record<string, string> = {};
  for (let i = start; i + 1 < tokens.length; i += 2) {
    const key = tokens[i];
    const value = tokens[i + 1];
    if (key.length === 0) continue;
    kv[key] = value;
  }
  return kv;
}

/**
 * Extract indexed player entries (player_N, frags_N, ping_N, team_N) from the
 * flat key/value map into a structured player list.
 */
function extractPlayers(kv: Record<string, string>): GameSpyPlayer[] {
  const players: GameSpyPlayer[] = [];

  for (const [key, value] of Object.entries(kv)) {
    if (!key.startsWith("player_")) continue;
    const index = key.slice("player_".length);

    const fragsRaw = kv[`frags_${index}`];
    const pingRaw = kv[`ping_${index}`];
    const frags = fragsRaw !== undefined ? parseInt(fragsRaw, 10) : NaN;
    const ping = pingRaw !== undefined ? parseInt(pingRaw, 10) : NaN;

    players.push({
      name: value,
      frags: isNaN(frags) ? null : frags,
      ping: isNaN(ping) ? null : ping,
      team: kv[`team_${index}`] ?? null,
    });
  }

  return players;
}

/**
 * Build the structured result from the merged key/value map.
 */
function buildResult(kv: Record<string, string>): GameSpyQueryResult {
  const players = extractPlayers(kv);

  const numPlayersRaw = kv["numplayers"];
  const maxPlayersRaw = kv["maxplayers"];
  const numPlayers = numPlayersRaw !== undefined
    ? parseInt(numPlayersRaw, 10)
    : NaN;
  const maxPlayers = maxPlayersRaw !== undefined
    ? parseInt(maxPlayersRaw, 10)
    : NaN;

  // Keys we surface as first-class fields; everything else goes to `extra`.
  const knownPrefixes = [
    "player_",
    "frags_",
    "ping_",
    "team_",
    "mesh_",
    "skin_",
    "face_",
    "ngsecret_",
  ];
  const knownKeys = new Set([
    "hostname",
    "mapname",
    "gametype",
    "numplayers",
    "maxplayers",
  ]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(kv)) {
    if (knownKeys.has(k)) continue;
    if (knownPrefixes.some((p) => k.startsWith(p))) continue;
    extra[k] = v;
  }

  return {
    numPlayers: isNaN(numPlayers) ? players.length : numPlayers,
    maxPlayers: isNaN(maxPlayers) ? 0 : maxPlayers,
    map: kv["mapname"] ?? "",
    hostName: kv["hostname"] ?? "",
    gameType: kv["gametype"] ?? "",
    players,
    extra,
  };
}

/**
 * Query a GameSpy v1 (text protocol) game server such as UT99 or UT2004.
 *
 * Sends a `\status\` request and reassembles the (possibly multi-packet)
 * response. Each response packet ends with a `\queryid\<id>.<n>` marker, and
 * the final packet additionally contains a `\final\` marker. Throws on failure
 * or timeout.
 */
export async function queryGameSpy(
  host: string,
  port: number,
): Promise<GameSpyQueryResult> {
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
            () => reject(new Error("GameSpy query timed out")),
          );
        }),
      ]);
      return data;
    };

    await socket.send(STATUS_REQUEST, remote);

    // Latin1 keeps each byte intact for names that may not be valid UTF-8.
    const decoder = new TextDecoder("latin1");
    let merged = "";
    let sawFinal = false;

    // Reassemble packets until we see the `\final\` marker (or time out).
    while (!sawFinal) {
      const packet = await receive();
      let chunk = decoder.decode(packet);

      if (chunk.includes("\\final\\")) {
        sawFinal = true;
      }

      // Strip control markers so they don't pollute the key/value parse.
      chunk = chunk
        .replace(/\\queryid\\[^\\]*/g, "")
        .replace(/\\final\\/g, "");

      merged += chunk;
    }

    const kv = parseKeyValues(merged);
    return buildResult(kv);
  } finally {
    socket.close();
  }
}
