// TrackMania Forever query via GBXRemote, the dedicated server's XML-RPC
// interface (TCP, default port 5000).
//
// There is no connectionless query for TMF. Everything goes through the same
// XML-RPC port XASECO and other controllers use, and every call needs a login
// first. The User level is enough for all the read-only methods below, so the
// caller supplies the User password per request (Docker Control never stores
// it). The `port` is the server's xmlrpc_port, not the game port.
//
// Wire format (GBXRemote 2):
//   handshake  server -> client: u32 LE length, then "GBXRemote 2"
//   request    u32 LE size, u32 LE handle, XML-RPC methodCall
//   response   u32 LE size, u32 LE handle, XML-RPC methodResponse
// Handles start at 0x80000000 and count up. Frames with the high bit clear are
// server callbacks, which only appear after EnableCallbacks; we skip them
// anyway. Reference: XASECO's includes/GbxRemote.inc.php.
//
// Method list and auth levels: https://methods.xaseco.org/methodstmf.php

export interface TrackmaniaPlayer {
  // Nickname with the $-formatting stripped.
  name: string;
  login: string;
  spectator: boolean;
  // Rank and best time (ms) on the current track this session, from
  // GetCurrentRanking. null when the player hasn't set a time yet.
  rank: number | null;
  bestTime: number | null;
}

// Field names mirror GameSpyQueryResult so the caller's per-server detail can
// share one shape for "who is on and what map is running".
export interface TrackmaniaQueryResult {
  numPlayers: number;
  maxPlayers: number;
  map: string;
  hostName: string;
  gameType: string;
  players: TrackmaniaPlayer[];
  // Track metadata that doesn't fit the fields above.
  extra: Record<string, string>;
}

const TIMEOUT_MS = 3000;
const FIRST_HANDLE = 0x80000000;
const HANDSHAKE = "GBXRemote 2";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// TMF login level whose password the caller passes in. User is the lowest of
// the three fixed levels and covers every Get* method used here.
const LOGIN = "User";

// Upper bound for the list methods. TMF caps players well below this.
const LIST_MAX = 250;

// GetCurrentGameInfo().GameMode
const GAME_MODES: Record<number, string> = {
  0: "Rounds",
  1: "TimeAttack",
  2: "Team",
  3: "Laps",
  4: "Stunts",
  5: "Cup",
};

// ---------------------------------------------------------------------------
// XML-RPC encoding
// ---------------------------------------------------------------------------

type XmlRpcValue =
  | string
  | number
  | boolean
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function encodeParam(value: string | number | boolean): string {
  if (typeof value === "boolean") {
    return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  }
  if (typeof value === "number") return `<value><int>${value}</int></value>`;

  return `<value><string>${escapeXml(value)}</string></value>`;
}

function encodeCall(
  method: string,
  params: (string | number | boolean)[],
): string {
  const body = params.map((p) => `<param>${encodeParam(p)}</param>`).join("");

  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName>` +
    `<params>${body}</params></methodCall>`;
}

// ---------------------------------------------------------------------------
// XML-RPC decoding
// ---------------------------------------------------------------------------
// The server's responses are regular enough that a small cursor over the
// element grammar beats pulling in an XML library.

function decodeEntities(text: string): string {
  return text
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, hex) => String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

class XmlCursor {
  private pos = 0;

  constructor(private readonly src: string) {}

  seek(marker: string): boolean {
    const at = this.src.indexOf(marker, this.pos);
    if (at === -1) return false;

    this.pos = at;
    return true;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }

  peekTag(tag: string): boolean {
    this.skipWhitespace();
    return this.src.startsWith(tag, this.pos);
  }

  expectTag(tag: string): void {
    if (!this.peekTag(tag)) {
      throw new Error(
        `XML-RPC parse error: expected ${tag} at offset ${this.pos}`,
      );
    }
    this.pos += tag.length;
  }

  // Raw text up to the closing tag, entities decoded.
  readTextUntil(closing: string): string {
    const end = this.src.indexOf(closing, this.pos);
    if (end === -1) {
      throw new Error(`XML-RPC parse error: unterminated ${closing}`);
    }

    const text = this.src.slice(this.pos, end);
    this.pos = end + closing.length;
    return decodeEntities(text);
  }

  parseValue(): XmlRpcValue {
    this.expectTag("<value>");

    let value: XmlRpcValue;
    if (this.peekTag("<string>")) {
      this.pos += "<string>".length;
      value = this.readTextUntil("</string>");
    } else if (this.peekTag("<int>")) {
      this.pos += "<int>".length;
      value = parseInt(this.readTextUntil("</int>"), 10);
    } else if (this.peekTag("<i4>")) {
      this.pos += "<i4>".length;
      value = parseInt(this.readTextUntil("</i4>"), 10);
    } else if (this.peekTag("<boolean>")) {
      this.pos += "<boolean>".length;
      value = this.readTextUntil("</boolean>").trim() === "1";
    } else if (this.peekTag("<double>")) {
      this.pos += "<double>".length;
      value = parseFloat(this.readTextUntil("</double>"));
    } else if (this.peekTag("<base64>")) {
      this.pos += "<base64>".length;
      value = this.readTextUntil("</base64>");
    } else if (this.peekTag("<struct>")) {
      value = this.parseStruct();
    } else if (this.peekTag("<array>")) {
      value = this.parseArray();
    } else {
      // Untyped value is a string per the spec.
      value = this.readTextUntil("</value>");
      return value;
    }

    this.expectTag("</value>");
    return value;
  }

  private parseStruct(): { [key: string]: XmlRpcValue } {
    this.expectTag("<struct>");

    const out: { [key: string]: XmlRpcValue } = {};
    while (this.peekTag("<member>")) {
      this.pos += "<member>".length;

      this.expectTag("<name>");
      const name = this.readTextUntil("</name>");
      out[name] = this.parseValue();

      this.expectTag("</member>");
    }

    this.expectTag("</struct>");
    return out;
  }

  private parseArray(): XmlRpcValue[] {
    this.expectTag("<array>");
    this.expectTag("<data>");

    const out: XmlRpcValue[] = [];
    while (this.peekTag("<value>")) {
      out.push(this.parseValue());
    }

    this.expectTag("</data>");
    this.expectTag("</array>");
    return out;
  }
}

// Returns the single result value of a methodResponse, or throws the fault.
function decodeResponse(xml: string): XmlRpcValue {
  const cursor = new XmlCursor(xml);

  if (cursor.seek("<fault>")) {
    cursor.expectTag("<fault>");
    const fault = cursor.parseValue() as { [key: string]: XmlRpcValue };
    throw new Error(
      `XML-RPC fault ${String(fault.faultCode)}: ${String(fault.faultString)}`,
    );
  }

  if (!cursor.seek("<params>")) {
    throw new Error("XML-RPC parse error: no params in response");
  }
  cursor.expectTag("<params>");
  cursor.expectTag("<param>");
  return cursor.parseValue();
}

// ---------------------------------------------------------------------------
// GBXRemote client
// ---------------------------------------------------------------------------

class GbxRemoteClient {
  private buf = new Uint8Array(0);
  private handle = FIRST_HANDLE;
  private readonly aborted: Promise<never>;

  constructor(
    private readonly conn: Deno.Conn,
    signal: AbortSignal,
  ) {
    this.aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("GBXRemote read timed out")),
        { once: true },
      );
    });
    // Every read races against this; the catch only keeps a late timeout from
    // surfacing as an unhandled rejection after we're done.
    this.aborted.catch(() => {});
  }

  private async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      const chunk = new Uint8Array(4096);
      const read = await Promise.race([this.conn.read(chunk), this.aborted]);
      if (read === null) throw new Error("GBXRemote connection closed");

      const merged = new Uint8Array(this.buf.length + read);
      merged.set(this.buf);
      merged.set(chunk.subarray(0, read), this.buf.length);
      this.buf = merged;
    }

    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  private async readU32(): Promise<number> {
    const bytes = await this.readExact(4);
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  }

  async handshake(): Promise<void> {
    const size = await this.readU32();
    if (size > 64) throw new Error("GBXRemote handshake header too large");

    const header = new TextDecoder().decode(await this.readExact(size));
    if (header !== HANDSHAKE) {
      throw new Error(`Unsupported GBXRemote protocol: ${header}`);
    }
  }

  async call(
    method: string,
    ...params: (string | number | boolean)[]
  ): Promise<XmlRpcValue> {
    const body = new TextEncoder().encode(encodeCall(method, params));
    const handle = ++this.handle;

    // Frame: size, handle, body.
    const frame = new Uint8Array(8 + body.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, body.length, true);
    view.setUint32(4, handle, true);
    frame.set(body, 8);
    await this.conn.write(frame);

    // Read frames until ours comes back. Anything with the high bit clear is
    // a callback and gets dropped.
    while (true) {
      const size = await this.readU32();
      if (size > MAX_FRAME_BYTES) {
        throw new Error("GBXRemote response frame too large");
      }

      const recvHandle = await this.readU32();
      const xml = new TextDecoder().decode(await this.readExact(size));

      if ((recvHandle & FIRST_HANDLE) === 0) continue;
      if (recvHandle !== handle) continue;

      return decodeResponse(xml);
    }
  }
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

type Struct = { [key: string]: XmlRpcValue };

function asStruct(value: XmlRpcValue, method: string): Struct {
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${method} returned a non-struct value`);
  }
  return value;
}

function asStructArray(value: XmlRpcValue, method: string): Struct[] {
  if (!Array.isArray(value)) {
    throw new Error(`${method} returned a non-array value`);
  }
  return value.map((entry) => asStruct(entry, method));
}

function str(struct: Struct, key: string): string {
  const value = struct[key];
  return typeof value === "string" ? value : "";
}

function num(struct: Struct, key: string): number | null {
  const value = struct[key];
  return typeof value === "number" && !isNaN(value) ? value : null;
}

// Strip TM text formatting: $$ literal, $xxx colours, $l[url]/$h[link] link
// openers and the single-letter style codes ($o $i $w $n $m $t $s $g $z $l $h
// $p $< $>).
function stripFormatting(text: string): string {
  return text.replace(
    /\$(\$|[0-9a-f]{3}|[lh]\[[^\]]*\]|[a-z<>])/gi,
    (_, code: string) => (code === "$" ? "$" : ""),
  );
}

// Flags = ForceSpectator + IsReferee*10 + IsPodiumReady*100 + ... + IsServer*100000
function isServerEntry(flags: number | null): boolean {
  return flags !== null && Math.floor(flags / 100000) % 10 === 1;
}

// SpectatorStatus = Spectator + TemporarySpectator*10 + PureSpectator*100 + ...
function isSpectating(status: number | null): boolean {
  return status !== null && status % 10 === 1;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Query a TrackMania Forever dedicated server over GBXRemote.
 * Requires the server's User level password. Throws on missing password, auth
 * failure, timeout, or connection error.
 */
export async function queryTrackmania(
  host: string,
  port: number,
  userPassword?: string,
): Promise<TrackmaniaQueryResult> {
  if (!userPassword) {
    throw new Error("Trackmania query requires the server's User password");
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const conn = await Promise.race([
    Deno.connect({ hostname: host, port, transport: "tcp" }),
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("GBXRemote connect timed out")),
        { once: true },
      );
    }),
  ]);

  try {
    const client = new GbxRemoteClient(conn, signal);
    await client.handshake();

    const authed = await client.call("Authenticate", LOGIN, userPassword);
    if (authed !== true) {
      throw new Error("GBXRemote authentication failed (bad User password)");
    }

    // Server, track and mode.
    const options = asStruct(
      await client.call("GetServerOptions", 0),
      "GetServerOptions",
    );
    const challenge = asStruct(
      await client.call("GetCurrentChallengeInfo"),
      "GetCurrentChallengeInfo",
    );
    const game = asStruct(
      await client.call("GetCurrentGameInfo", 0),
      "GetCurrentGameInfo",
    );

    // Who is on. Compatibility 1 = Forever listing, which leaves the server's
    // own login out; the IsServer flag check is belt and braces.
    const entries = asStructArray(
      await client.call("GetPlayerList", LIST_MAX, 0, 1),
      "GetPlayerList",
    ).filter((entry) => !isServerEntry(num(entry, "Flags")));

    // Best times on the current track, keyed by login. BestTime is -1 until a
    // player finishes a run.
    const ranking = asStructArray(
      await client.call("GetCurrentRanking", LIST_MAX, 0),
      "GetCurrentRanking",
    );
    const rankByLogin = new Map<
      string,
      { rank: number | null; bestTime: number | null }
    >();
    for (const entry of ranking) {
      const bestTime = num(entry, "BestTime");
      rankByLogin.set(str(entry, "Login"), {
        rank: num(entry, "Rank"),
        bestTime: bestTime !== null && bestTime >= 0 ? bestTime : null,
      });
    }

    const players: TrackmaniaPlayer[] = entries.map((entry) => {
      const login = str(entry, "Login");
      const times = rankByLogin.get(login);
      const bestTime = times?.bestTime ?? null;

      return {
        name: stripFormatting(str(entry, "NickName")) || login,
        login,
        spectator: isSpectating(num(entry, "SpectatorStatus")),
        rank: bestTime !== null ? times?.rank ?? null : null,
        bestTime,
      };
    });

    const gameMode = num(game, "GameMode");
    const authorTime = num(challenge, "AuthorTime");

    return {
      numPlayers: players.length,
      maxPlayers: num(options, "CurrentMaxPlayers") ?? 0,
      map: stripFormatting(str(challenge, "Name")),
      hostName: stripFormatting(str(options, "Name")),
      gameType: gameMode !== null
        ? GAME_MODES[gameMode] ?? String(gameMode)
        : "",
      players,
      extra: {
        environment: str(challenge, "Environnement"),
        author: str(challenge, "Author"),
        authorTime: authorTime !== null ? String(authorTime) : "",
        uid: str(challenge, "UId"),
      },
    };
  } finally {
    try {
      conn.close();
    } catch {
      // Connection may already be closed; ignore.
    }
  }
}
