import { VERSION } from "./version.ts";

import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { cors } from "hono/cors";
import { Command } from "@cliffy/command";
import * as path from "@std/path";

import "@std/dotenv/load"; // Automatically load .env file

import { middlewareRateLimit } from "./lib/middleware/ratelimit/index.ts";
import { middlewareAuth } from "./lib/middleware/auth/index.ts";
import { DockerService } from "./lib/docker/index.ts";

// Custom logger that handles silent mode and file logging
class Logger {
  private logFile: string | null = null;
  private silent: boolean = false;

  constructor(options?: { logFile?: string; silent?: boolean }) {
    this.logFile = options?.logFile || null;
    this.silent = options?.silent || false;
  }

  // Log to both console and file if specified
  async log(message: string, level: "info" | "error" = "info") {
    const timestamp = new Date().toISOString();
    const formattedMessage = `${timestamp} [${level.toUpperCase()}] ${message}`;

    // Write to file if specified
    if (this.logFile) {
      try {
        await Deno.writeTextFile(
          this.logFile,
          formattedMessage + "\n",
          { append: true, create: true },
        );
      } catch (error) {
        // Only log file errors to console if not in silent mode
        if (!this.silent) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          console.error(`Failed to write to log file: ${message}`);
        }
      }
    }

    // Output to console if not in silent mode
    if (!this.silent) {
      if (level === "error") {
        console.error(formattedMessage);
      } else {
        console.log(formattedMessage);
      }
    }
  }

  info(message: string) {
    return this.log(message, "info");
  }

  error(message: string) {
    return this.log(message, "error");
  }
}

// Create a logger instance based on command options
function createLogger(options: { silent?: boolean; logFile?: string }) {
  const logFilePath = options.logFile;

  // If log file path is provided, ensure the directory exists
  if (logFilePath) {
    try {
      const dirPath = path.dirname(logFilePath);
      Deno.mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to create log directory: ${message}`);
    }
  }

  return new Logger({
    logFile: logFilePath,
    silent: options.silent || false,
  });
}

// Function to start the server
async function startServer(options: {
  silent?: boolean;
  logFile?: string;
}) {
  const logger = createLogger(options);

  // Load environment variables
  if (!Deno.env.get("DOCKER_CONTROL_TOKEN")) {
    await logger.error(
      "Error: DOCKER_CONTROL_TOKEN is not set in the environment variables.",
    );
    Deno.exit(1);
  }

  // Check if the socket exists.
  const socketPath = Deno.env.get("DOCKER_CONTROL_SOCKET") ||
    "/var/run/docker.sock";
  try {
    await Deno.stat(socketPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      await logger.error(`Socket not found at ${socketPath}`);
      Deno.exit(1);
    } else {
      await logger.error(`Unexpected Error: ${err}`);
      Deno.exit(1);
    }
  }

  const dockerService = new DockerService();
  const app = new Hono();

  // Enable logging middleware if not in silent mode
  if (!options.silent) {
    app.use(honoLogger());
  }

  // Enable CORS middleware
  app.use(
    "/*",
    cors({
      origin: "*",
      allowMethods: ["GET"],
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );

  // Apply custom middlewares
  app.use("/*", middlewareRateLimit, middlewareAuth);

  // Endpoint to list running Docker containers
  app.get("/containers", async (c) => {
    try {
      const data = await dockerService.getAllContainers();
      return c.json(data);
    } catch (err) {
      await logger.error(`Unexpected Error: ${err}`);
      return c.text("Internal Server Error", 500);
    }
  });

  app.get("/names", async (c) => {
    try {
      const names = await dockerService.getContainerNames();
      return c.json(names);
    } catch (err) {
      await logger.error(`Unexpected Error: ${err}`);
      return c.text("Internal Server Error", 500);
    }
  });

  app.get("/status", async (c) => {
    try {
      const statusInfo = await dockerService.getContainerStatus();
      return c.json(statusInfo);
    } catch (err) {
      await logger.error(`Unexpected Error: ${err}`);
      return c.text("Internal Server Error", 500);
    }
  });

  app.post("/control/:association/:value/start", async (c) => {
    const association = c.req.param("association");
    const value = c.req.param("value");

    try {
      let container;
      switch (association) {
        case "id":
          container = await dockerService.findContainerById(value);
          break;
        case "name":
          container = await dockerService.findContainerByName(value);
          break;
        default:
          return c.json(
            { error: "Invalid association parameter. Use 'id' or 'name'." },
            400,
          );
      }

      if (!container) {
        return c.json(
          { error: `Container with ${association} '${value}' not found` },
          404,
        );
      }

      // Use the container ID for the operation
      const result = await dockerService.startContainer(container.Id);
      return c.json(result);
    } catch (err) {
      await logger.error(
        `Error starting container with ${association} '${value}': ${err}`,
      );
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  app.post("/control/:association/:value/stop", async (c) => {
    const association = c.req.param("association");
    const value = c.req.param("value");

    try {
      let container;
      switch (association) {
        case "id":
          container = await dockerService.findContainerById(value);
          break;
        case "name":
          container = await dockerService.findContainerByName(value);
          break;
        default:
          return c.json(
            { error: "Invalid association parameter. Use 'id' or 'name'." },
            400,
          );
      }

      if (!container) {
        return c.json(
          { error: `Container with ${association} '${value}' not found` },
          404,
        );
      }

      // Use the container ID for the operation
      const result = await dockerService.stopContainer(container.Id);
      return c.json(result);
    } catch (err) {
      await logger.error(
        `Error stopping container with ${association} '${value}': ${err}`,
      );
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  app.post("/control/:association/:value/restart", async (c) => {
    const association = c.req.param("association");
    const value = c.req.param("value");

    try {
      let container;
      switch (association) {
        case "id":
          container = await dockerService.findContainerById(value);
          break;
        case "name":
          container = await dockerService.findContainerByName(value);
          break;
        default:
          return c.json(
            { error: "Invalid association parameter. Use 'id' or 'name'." },
            400,
          );
      }

      if (!container) {
        return c.json(
          { error: `Container with ${association} '${value}' not found` },
          404,
        );
      }

      // Use the container ID for the operation
      const result = await dockerService.restartContainer(container.Id);
      return c.json(result);
    } catch (err) {
      await logger.error(
        `Error restarting container with ${association} '${value}': ${err}`,
      );
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  app.get("/control/:association/:value/logs", async (c) => {
    const association = c.req.param("association");
    const value = c.req.param("value");

    // Get the optional tail parameter (number of lines)
    const tailParam = c.req.query("tail");
    const tail = tailParam ? parseInt(tailParam, 10) : undefined;

    try {
      let container;
      switch (association) {
        case "id":
          container = await dockerService.findContainerById(value);
          break;
        case "name":
          container = await dockerService.findContainerByName(value);
          break;
        default:
          return c.json(
            { error: "Invalid association parameter. Use 'id' or 'name'." },
            400,
          );
      }

      if (!container) {
        return c.json(
          { error: `Container with ${association} '${value}' not found` },
          404,
        );
      }

      // Use the container ID for the operation
      const result = await dockerService.getContainerLogs(container.Id, tail);
      return c.text(result);
    } catch (err) {
      await logger.error(
        `Error getting logs for container with ${association} '${value}': ${err}`,
      );
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.text("Internal Server Error", 500);
    }
  });

  app.get("/control/:association/:value/status", async (c) => {
    const association = c.req.param("association");
    const value = c.req.param("value");

    try {
      let container;
      switch (association) {
        case "id":
          container = await dockerService.findContainerById(value);
          break;
        case "name":
          container = await dockerService.findContainerByName(value);
          break;
        default:
          return c.json(
            { error: "Invalid association parameter. Use 'id' or 'name'." },
            400,
          );
      }

      if (!container) {
        return c.json(
          { error: `Container with ${association} '${value}' not found` },
          404,
        );
      }

      // Use the container ID for the operation
      const result = await dockerService.getContainerStatusById(container.Id);
      return c.json(result);
    } catch (err) {
      await logger.error(
        `Error getting status for container with ${association} '${value}': ${err}`,
      );
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // Fallback Route
  app.notFound((c) => c.text(`API path '${c.req.path}' not found`, 404));

  // Start the server
  const DOCKER_CONTROL_PORT = Deno.env.get("DOCKER_CONTROL_PORT") || 54320;
  Deno.serve(
    {
      port: Number(DOCKER_CONTROL_PORT),
      onListen: () => {
        logger.info(
          `Docker Control is running at http://127.0.0.1:${DOCKER_CONTROL_PORT}`,
        );
      },
    },
    app.fetch,
  );
}

// Export server function to be called by CLI
function start(options: {
  silent?: boolean;
  logFile?: string;
}) {
  startServer(options);
}

// Parse command line arguments
function setupCLI() {
  return new Command()
    .name("docker-control")
    .version(VERSION)
    .description("Hivecom Docker container orchestration and metrics API")
    .option("-s, --silent", "Run in silent mode (no console output)")
    .option("-l, --log-file <path:string>", "Log output to the specified file")
    .action(start)
    .command("serve", "Start the Docker control API server")
    .option("-s, --silent", "Run in silent mode (no console output)")
    .option("-l, --log-file <path:string>", "Log output to the specified file")
    .action(start);
}

// Create CLI parser
const cli = setupCLI();

// Run the CLI
if (import.meta.main) {
  cli.parse(Deno.args);
}
