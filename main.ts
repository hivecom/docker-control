import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";

import "@std/dotenv/load"; // Automatically load .env file

import { middlewareRateLimit } from "./lib/middleware/ratelimit/index.ts";
import { middlewareAuth } from "./lib/middleware/auth/index.ts";
import { DockerService } from "./lib/docker/index.ts";

// Load environment variables
if (!Deno.env.get("DOCKER_CONTROL_TOKEN")) {
  console.error(
    "Error: DOCKER_CONTROL_TOKEN is not set in the environment variables."
  );
  Deno.exit(1);
}

// Check if the socket exists.
const socketPath =
  Deno.env.get("DOCKER_CONTROL_SOCKET") || "/var/run/docker.sock";
try {
  await Deno.stat(socketPath);
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.error(`Socket not found at ${socketPath}`);
    Deno.exit(1);
  } else {
    console.error("Unexpected Error:", err);
    Deno.exit(1);
  }
}

const dockerService = new DockerService();
const app = new Hono();

// Enable CORS and logger middleware
app.use(logger());
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["Authorization", "Content-Type"],
  })
);

// Apply custom middlewares
app.use("/*", middlewareAuth, middlewareRateLimit);

// Endpoint to list running Docker containers
app.get("/containers", async (c) => {
  try {
    const data = await dockerService.getAllContainers();
    return c.json(data);
  } catch (err) {
    console.error("Unexpected Error:", err);
    return c.text("Internal Server Error", 500);
  }
});

app.get("/names", async (c) => {
  try {
    const names = await dockerService.getContainerNames();
    return c.json(names);
  } catch (err) {
    console.error("Unexpected Error:", err);
    return c.text("Internal Server Error", 500);
  }
});

app.get("/status", async (c) => {
  try {
    const statusInfo = await dockerService.getContainerStatus();
    return c.json(statusInfo);
  } catch (err) {
    console.error("Unexpected Error:", err);
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
          400
        );
    }

    if (!container) {
      return c.json(
        { error: `Container with ${association} '${value}' not found` },
        404
      );
    }

    // Use the container ID for the operation
    const result = await dockerService.startContainer(container.Id);
    return c.json(result);
  } catch (err) {
    console.error(
      `Error starting container with ${association} '${value}':`,
      err
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
          400
        );
    }

    if (!container) {
      return c.json(
        { error: `Container with ${association} '${value}' not found` },
        404
      );
    }

    // Use the container ID for the operation
    const result = await dockerService.stopContainer(container.Id);
    return c.json(result);
  } catch (err) {
    console.error(
      `Error stopping container with ${association} '${value}':`,
      err
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
          400
        );
    }

    if (!container) {
      return c.json(
        { error: `Container with ${association} '${value}' not found` },
        404
      );
    }

    // Use the container ID for the operation
    const result = await dockerService.restartContainer(container.Id);
    return c.json(result);
  } catch (err) {
    console.error(
      `Error restarting container with ${association} '${value}':`,
      err
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
          400
        );
    }

    if (!container) {
      return c.json(
        { error: `Container with ${association} '${value}' not found` },
        404
      );
    }

    // Use the container ID for the operation
    const result = await dockerService.getContainerLogs(container.Id, tail);
    return c.json(result);
  } catch (err) {
    console.error(
      `Error getting logs for container with ${association} '${value}':`,
      err
    );
    if (err instanceof Error && err.message.includes("not found")) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Internal Server Error" }, 500);
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
          400
        );
    }

    if (!container) {
      return c.json(
        { error: `Container with ${association} '${value}' not found` },
        404
      );
    }

    // Use the container ID for the operation
    const result = await dockerService.getContainerStatusById(container.Id);
    return c.json(result);
  } catch (err) {
    console.error(
      `Error getting status for container with ${association} '${value}':`,
      err
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
      console.log(
        `Docker Control is running at http://127.0.0.1:${DOCKER_CONTROL_PORT}`
      );
    },
  },
  app.fetch
);
