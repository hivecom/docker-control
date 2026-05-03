import { querySource } from "./protocols/source.ts";
import { queryMinecraft } from "./protocols/minecraft.ts";

export type QueryProtocol = "source" | "minecraft";

export interface GameServerQueryResult {
  playerCount: number | null;
  maxPlayers: number | null;
  world: string | null;
  // Minecraft-specific (only present when protocol = 'minecraft')
  players?: string[];
  motd?: string;
  gameType?: string;
  gameId?: string;
  version?: string;
  plugins?: string;
  hostPort?: number;
  hostIp?: string;
  extra?: Record<string, string>;
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
      case "minecraft": {
        const result = await queryMinecraft(host, port);
        return {
          playerCount: result.playerCount,
          maxPlayers: result.maxPlayers,
          world: result.world,
          players: result.players,
          motd: result.motd,
          gameType: result.gameType,
          gameId: result.gameId,
          version: result.version,
          plugins: result.plugins,
          hostPort: result.hostPort,
          hostIp: result.hostIp,
          extra: result.extra,
        };
      }
      case "source": {
        const result = await querySource(host, port);
        return {
          playerCount: result.playerCount,
          maxPlayers: result.maxPlayers,
          world: result.map,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[query] ${protocol}://${host}:${port} failed: ${message}`);
    return { playerCount: null, maxPlayers: null, world: null };
  }
}
