import { querySource } from "./protocols/source.ts";

export type QueryProtocol = "source";

export interface GameServerQueryResult {
  playerCount: number | null;
  maxPlayers: number | null;
  map: string | null;
}

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
      case "source": {
        const result = await querySource(host, port);
        return {
          playerCount: result.playerCount,
          maxPlayers: result.maxPlayers,
          map: result.map,
        };
      }
    }
  } catch {
    return { playerCount: null, maxPlayers: null, map: null };
  }
}
