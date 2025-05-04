import { DockerContainer } from "../../types/docker.ts";
import { querySocket } from "../socket/index.ts";

export class DockerService {
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ||
      Deno.env.get("DOCKER_CONTROL_SOCKET") ||
      "/var/run/docker.sock";
  }

  /**
   * Get all containers
   */
  async getAllContainers(): Promise<DockerContainer[]> {
    return await querySocket<DockerContainer[]>(
      this.socketPath,
      "/containers/json?all=true",
    );
  }

  /**
   * Get container names
   */
  async getContainerNames(): Promise<string[]> {
    const containers = await this.getAllContainers();
    return containers.map((container) => container.Names[0].slice(1));
  }

  /**
   * Find a container by name
   */
  async findContainerByName(
    name: string,
  ): Promise<DockerContainer | undefined> {
    const containers = await this.getAllContainers();
    return containers.find((container) =>
      container.Names.some((n) => n === `/${name}` || n.slice(1) === name)
    );
  }

  /**
   * Find a container by ID
   */
  async findContainerById(id: string): Promise<DockerContainer | undefined> {
    const containers = await this.getAllContainers();
    return containers.find(
      (container) => container.Id === id || container.Id.startsWith(id),
    );
  }

  /**
   * Get container status information
   */
  async getContainerStatus(): Promise<
    Array<{
      id: string;
      name: string;
      health: string;
      status: string;
      started: number | null;
    }>
  > {
    const containers = await this.getAllContainers();
    const results = [];

    for (const container of containers) {
      // Extract container name (removing leading slash)
      const name = container.Names[0].slice(1);

      // Get the status text
      const status = container.Status;

      // Extract health state from status or labels if available
      // Default to container state if health check not configured
      const health = container.State;

      // Try to determine start timestamp from container inspect API
      let started: number | null = null;

      // Get more detailed information about the container if it's running
      if (container.State === "running") {
        try {
          // Get detailed container information from Docker API
          const containerDetails = await querySocket<{
            State?: {
              StartedAt?: string;
            };
          }>(this.socketPath, `/containers/${container.Id}/json`);

          // Extract start timestamp from container details
          if (containerDetails.State && containerDetails.State.StartedAt) {
            const startedAt = containerDetails.State.StartedAt;
            if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
              started = new Date(startedAt).getTime();
            }
          }
        } catch (error) {
          // If there's an error getting detailed info, fallback to Created timestamp
          console.error(
            `Error getting details for container ${container.Id}: ${error}`,
          );
          started = container.Created;
        }
      }

      results.push({
        id: container.Id,
        name,
        health,
        status,
        started,
      });
    }

    return results;
  }

  /**
   * Start a container by ID
   */
  async startContainer(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const container = await this.findContainerById(id);

    if (!container) {
      throw new Error(`Container with ID '${id}' not found`);
    }

    // Docker API returns empty response for container start, so we use { expectEmptyResponse: true }
    await querySocket(this.socketPath, `/containers/${id}/start`, "POST", {
      expectEmptyResponse: true,
    });

    const name = container.Names[0].slice(1);
    return {
      success: true,
      message: `Container '${name}' (${
        id.substring(
          0,
          12,
        )
      }) started successfully`,
    };
  }

  /**
   * Stop a container by ID
   */
  async stopContainer(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const container = await this.findContainerById(id);

    if (!container) {
      throw new Error(`Container with ID '${id}' not found`);
    }

    // Docker API returns empty response for container stop, so we use { expectEmptyResponse: true }
    await querySocket(this.socketPath, `/containers/${id}/stop`, "POST", {
      expectEmptyResponse: true,
    });

    const name = container.Names[0].slice(1);
    return {
      success: true,
      message: `Container '${name}' (${
        id.substring(
          0,
          12,
        )
      }) stopped successfully`,
    };
  }

  /**
   * Restart a container by ID
   */
  async restartContainer(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const container = await this.findContainerById(id);

    if (!container) {
      throw new Error(`Container with ID '${id}' not found`);
    }

    // Docker API returns empty response for container restart, so we use { expectEmptyResponse: true }
    await querySocket(this.socketPath, `/containers/${id}/restart`, "POST", {
      expectEmptyResponse: true,
    });

    const name = container.Names[0].slice(1);
    return {
      success: true,
      message: `Container '${name}' (${
        id.substring(
          0,
          12,
        )
      }) restarted successfully`,
    };
  }

  /**
   * Get logs for a container by ID
   */
  async getContainerLogs(id: string, tail?: number): Promise<string> {
    const container = await this.findContainerById(id);

    if (!container) {
      throw new Error(`Container with ID '${id}' not found`);
    }

    // Build query string for logs endpoint
    const queryParams = new URLSearchParams({
      stdout: "true",
      stderr: "true",
    });

    if (tail !== undefined) {
      queryParams.append("tail", tail.toString());
    }

    // Get the raw logs as text
    const logs = await querySocket<string>(
      this.socketPath,
      `/containers/${id}/logs?${queryParams.toString()}`,
      "GET",
      { rawResponse: true },
    );

    return logs;
  }

  /**
   * Get detailed status for a specific container by ID
   */
  async getContainerStatusById(id: string): Promise<{
    id: string;
    name: string;
    health: string;
    status: string;
    startTimestamp: number | null;
    state: string;
    image: string;
    created: number;
  }> {
    const container = await this.findContainerById(id);

    if (!container) {
      throw new Error(`Container with ID '${id}' not found`);
    }

    // Get more detailed information about the container
    const containerDetails = await querySocket<{
      State?: {
        Health?: { Status: string };
        StartedAt?: string;
      };
    }>(this.socketPath, `/containers/${id}/json`);

    // Process container details
    const name = container.Names[0].slice(1);
    const status = container.Status;

    // Extract health state from inspect data if available
    let health = container.State;
    if (containerDetails.State && containerDetails.State.Health) {
      health = containerDetails.State.Health.Status;
    }

    // Try to determine start timestamp
    let startTimestamp: number | null = null;
    if (containerDetails.State && containerDetails.State.StartedAt) {
      const startedAt = containerDetails.State.StartedAt;
      if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
        startTimestamp = new Date(startedAt).getTime();
      }
    }

    return {
      id: container.Id,
      name,
      health,
      status,
      startTimestamp,
      state: container.State,
      image: container.Image,
      created: container.Created,
    };
  }
}
