// Factorio query via the Source RCON protocol (TCP).
//
// Factorio has no connectionless UDP query that exposes player counts, so we
// authenticate over RCON and run a command to read the live player data. This
// requires the server's RCON password, supplied per-request by the caller
// (Docker Control never stores it). The `port` is the server's configured RCON
// port (`--rcon-port`), not the game port.
//
// Two modes:
//   - Default: the built-in `/players online count` command (alias `/p o c`),
//     which prints only the number of currently connected players.
//   - `useLua`: a `/silent-command` that additionally returns player names and
//     the configured max-player limit. This disables achievements on the save,
//     so it is opt-in by the caller.
//
// Source RCON reference: https://developer.valvesoftware.com/wiki/Source_RCON_Protocol

export interface FactorioQueryResult {
  numPlayers: number;
  // Configured player limit (0 = unlimited). null when not retrieved
  // (default `/players online count` mode does not report it).
  maxPlayers: number | null;
  // Online player names. Empty unless the Lua mode is used.
  players: string[];
}

const TIMEOUT_MS = 3000;

// RCON packet types.
const SERVERDATA_RESPONSE_VALUE = 0;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_AUTH = 3;

// Request IDs we use to correlate responses. Auth failure is signalled by the
// server echoing an ID of -1.
const AUTH_REQUEST_ID = 0x5243; // "RC"
const EXEC_REQUEST_ID = 0x434e; // "CN"
const AUTH_FAILED_ID = -1;

// Built-in command that prints only the number of online players.
const COUNT_COMMAND = "/players online count";

// Lua command that prints "<count>|<maxPlayers>|<name>,<name>,...".
// Factorio usernames cannot contain commas or pipes, so the format is
// unambiguous. `game.max_players` is 0 when no limit is configured.
const LUA_COMMAND =
  "/silent-command local p={} for _,x in pairs(game.connected_players) do " +
  'p[#p+1]=x.name end rcon.print(#game.connected_players.."|"..' +
  'game.max_players.."|"..table.concat(p,","))';

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/**
 * Build a Source RCON packet.
 * Layout (LE): size(4) + id(4) + type(4) + body(ASCII, null-terminated) + null.
 * `size` counts everything after the size field itself.
 */
function buildPacket(id: number, type: number, body: string): Uint8Array {
  const bodyBytes = new TextEncoder().encode(body);
  const size = 4 + 4 + bodyBytes.length + 2; // id + type + body + 2 null bytes
  const buf = new Uint8Array(4 + size);
  const view = new DataView(buf.buffer);
  view.setInt32(0, size, true);
  view.setInt32(4, id, true);
  view.setInt32(8, type, true);
  buf.set(bodyBytes, 12);
  // Trailing two null bytes are already zero.
  return buf;
}

/**
 * Buffered reader that yields complete RCON packets from a TCP connection,
 * enforcing an overall timeout via the provided AbortSignal.
 */
class PacketReader {
  private buf = new Uint8Array(0);

  constructor(
    private readonly conn: Deno.Conn,
    private readonly signal: AbortSignal,
  ) {}

  private async fill(): Promise<boolean> {
    const chunk = new Uint8Array(4096);
    const n = await Promise.race([
      this.conn.read(chunk),
      new Promise<never>((_, reject) => {
        this.signal.addEventListener(
          "abort",
          () => reject(new Error("RCON read timed out")),
        );
      }),
    ]);
    if (n === null) return false; // EOF

    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf);
    merged.set(chunk.subarray(0, n), this.buf.length);
    this.buf = merged;
    return true;
  }

  /**
   * Read the next complete packet, or null on EOF.
   */
  async next(): Promise<RconPacket | null> {
    // Ensure we have the 4-byte size prefix.
    while (this.buf.length < 4) {
      if (!await this.fill()) return null;
    }

    const view = new DataView(this.buf.buffer, this.buf.byteOffset);
    const size = view.getInt32(0, true);
    const total = 4 + size;

    // Ensure the full packet is buffered.
    while (this.buf.length < total) {
      if (!await this.fill()) return null;
    }

    const id = view.getInt32(4, true);
    const type = view.getInt32(8, true);
    // Body is between offset 12 and the two trailing null bytes.
    const bodyBytes = this.buf.subarray(12, total - 2);
    const body = new TextDecoder("utf-8").decode(bodyBytes);

    this.buf = this.buf.slice(total);
    return { id, type, body };
  }
}

/**
 * Parse the `/players online count` output. It prints a line such as
 * "Online players (3):", so we extract the first integer in the response.
 */
function parseCountOutput(body: string): FactorioQueryResult {
  const match = body.match(/\d+/);
  return {
    numPlayers: match ? parseInt(match[0], 10) : 0,
    maxPlayers: null,
    players: [],
  };
}

/**
 * Parse the Lua command output ("<count>|<max>|<csv names>").
 */
function parseLuaOutput(body: string): FactorioQueryResult {
  const parts = body.trim().split("|");

  const numPlayers = parseInt(parts[0] ?? "", 10);
  const maxPlayers = parseInt(parts[1] ?? "", 10);
  const namesCsv = parts[2] ?? "";
  const players = namesCsv.length > 0 ? namesCsv.split(",") : [];

  return {
    numPlayers: isNaN(numPlayers) ? players.length : numPlayers,
    maxPlayers: isNaN(maxPlayers) ? null : maxPlayers,
    players,
  };
}

/**
 * Query a Factorio dedicated server over RCON.
 * Requires the server's RCON password. When `useLua` is true, additionally
 * retrieves player names and the max-player limit via a `/silent-command`
 * (which disables achievements on the save). Throws on missing password, auth
 * failure, timeout, or connection error.
 */
export async function queryFactorio(
  host: string,
  port: number,
  rconPassword?: string,
  useLua = false,
): Promise<FactorioQueryResult> {
  if (!rconPassword) {
    throw new Error("Factorio query requires an RCON password");
  }

  const command = useLua ? LUA_COMMAND : COUNT_COMMAND;
  const parse = useLua ? parseLuaOutput : parseCountOutput;

  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
  const conn = await Deno.connect({ hostname: host, port, transport: "tcp" });

  try {
    const reader = new PacketReader(conn, timeoutSignal);

    // Step 1: authenticate.
    await conn.write(
      buildPacket(AUTH_REQUEST_ID, SERVERDATA_AUTH, rconPassword),
    );

    // The server may send an empty RESPONSE_VALUE before the auth response;
    // read until we get the auth response packet.
    let authed = false;
    while (!authed) {
      const packet = await reader.next();
      if (packet === null) throw new Error("Connection closed during auth");
      if (packet.type !== SERVERDATA_AUTH_RESPONSE) continue;
      if (packet.id === AUTH_FAILED_ID) {
        throw new Error("RCON authentication failed (bad password)");
      }
      authed = true;
    }

    // Step 2: run the player-count command.
    await conn.write(
      buildPacket(EXEC_REQUEST_ID, SERVERDATA_EXECCOMMAND, command),
    );

    while (true) {
      const packet = await reader.next();
      if (packet === null) {
        throw new Error("Connection closed before command response");
      }
      if (packet.type === SERVERDATA_RESPONSE_VALUE) {
        return parse(packet.body);
      }
    }
  } finally {
    try {
      conn.close();
    } catch {
      // Connection may already be closed; ignore.
    }
  }
}
