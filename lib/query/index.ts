import { querySource, type SourceQueryResult } from "./protocols/source.ts";
import {
  type MinecraftQueryResult,
  queryMinecraft,
} from "./protocols/minecraft.ts";
import { type GameSpyQueryResult, queryGameSpy } from "./protocols/gamespy1.ts";
import {
  querySatisfactory,
  type SatisfactoryQueryResult,
} from "./protocols/satisfactory.ts";
import { type FactorioQueryResult, queryFactorio } from "./protocols/rcon.ts";

export type QueryProtocol =
  | "source"
  | "minecraft"
  | "gamespy1"
  | "satisfactory"
  | "factorio";

export type GameServerQueryResult =
  | SourceQueryResult
  | MinecraftQueryResult
  | GameSpyQueryResult
  | SatisfactoryQueryResult
  | FactorioQueryResult;

/**
 * Optional, per-request credentials/configuration injected by the caller.
 *
 * Docker Control is intentionally stateless and never persists secrets: the
 * caller (e.g. a trusted edge function) owns the secret store and passes the
 * relevant value in with each query. UDP/connectionless protocols ignore this;
 * credential-bearing protocols (planned: Factorio RCON, Satisfactory HTTPS
 * player counts) read from it.
 */
export interface QueryOptions {
  // Source RCON password (used by Factorio).
  rconPassword?: string;
  // Bearer token for the Satisfactory HTTPS API (planned: real player counts).
  authToken?: string;
  // Factorio only: use a `/silent-command` to also fetch player names and the
  // max-player limit. Disables achievements on the save, so it is opt-in.
  factorioUseLua?: boolean;
}

/**
 * Build the per-protocol "null result" returned when a query fails so callers
 * always receive a stable shape.
 */
function emptyResult(protocol: QueryProtocol): GameServerQueryResult {
  switch (protocol) {
    case "source":
      return {
        players: null,
        maxPlayers: null,
        map: null,
        playerList: null,
      } as unknown as SourceQueryResult;
    case "minecraft":
      return {
        numPlayers: null,
        maxPlayers: null,
        world: null,
        players: [],
      } as unknown as MinecraftQueryResult;
    case "gamespy1":
      return {
        numPlayers: null,
        maxPlayers: null,
        map: null,
        hostName: null,
        gameType: null,
        players: [],
        extra: {},
      } as unknown as GameSpyQueryResult;
    case "satisfactory":
      return {
        reachable: false,
        joinable: false,
        state: "offline",
        serverName: null,
        serverNetCL: null,
      } as unknown as SatisfactoryQueryResult;
    case "factorio":
      return {
        numPlayers: null,
        maxPlayers: null,
        players: [],
      } as unknown as FactorioQueryResult;
  }
}

/**
 * Query a game server using the specified protocol.
 * Always returns a result object - errors yield null/empty fields.
 *
 * `options` carries optional credentials supplied by the caller. It is reserved
 * for credential-bearing protocols; connectionless UDP protocols ignore it.
 */
export async function queryGameServer(
  protocol: QueryProtocol,
  host: string,
  port: number,
  options: QueryOptions = {},
): Promise<GameServerQueryResult> {
  try {
    switch (protocol) {
      case "source":
        return await querySource(host, port);
      case "minecraft":
        return await queryMinecraft(host, port);
      case "gamespy1":
        return await queryGameSpy(host, port);
      case "satisfactory":
        return await querySatisfactory(host, port);
      case "factorio":
        return await queryFactorio(
          host,
          port,
          options.rconPassword,
          options.factorioUseLua,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[query] ${protocol}://${host}:${port} failed: ${message}`);
    return emptyResult(protocol);
  }
}
