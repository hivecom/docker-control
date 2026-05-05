import { querySource, type SourceQueryResult } from "./protocols/source.ts";
import {
  type MinecraftQueryResult,
  queryMinecraft,
} from "./protocols/minecraft.ts";

export type QueryProtocol = "source" | "minecraft";

export type GameServerQueryResult = SourceQueryResult | MinecraftQueryResult;

/**
 * Query a game server using the specified protocol.
 * Always returns a result object - errors yield null fields.
 */
export async function queryGameServer(
  protocol: QueryProtocol,
  host: string,
  port: number,
): Promise<GameServerQueryResult> {
  try {
    switch (protocol) {
      case "source":
        return await querySource(host, port);
      case "minecraft":
        return await queryMinecraft(host, port);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[query] ${protocol}://${host}:${port} failed: ${message}`);
    if (protocol === "source") {
      return {
        players: null,
        maxPlayers: null,
        map: null,
        playerList: null,
      } as unknown as SourceQueryResult;
    } else {
      return {
        numPlayers: null,
        maxPlayers: null,
        world: null,
        players: [],
      } as unknown as MinecraftQueryResult;
    }
  }
}
