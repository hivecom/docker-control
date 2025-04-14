# docker-control

Hivecom network wide Docker container orchestration and metrics API using Hono and Deno.

## Setup

Make sure Deno is installed on your machine. You can follow the instructions [here](https://deno.land/manual/getting_started/installation) to install Deno.

Once Deno is installed, you can clone this repository and install the dependencies.

```bash
deno install
```

## Running the API

This is the most straightforward part.

```bash
deno task start
```

From here, you can access the API at `http://localhost:${DOCKER_CONTROL_PORT}` (default: `54320`).

Make sure you set the appropriate `DOCKER_CONTROL_KEY` in your environment variables. This is the key that will be used to authenticate requests to the API.

## API Endpoints

All API requests require the `Authorization` header containing the token matching the `DOCKER_CONTROL_TOKEN` environment variable.

| Method | Endpoint | Description | Parameters |
|--------|----------|-------------|------------|
| **Container Management** ||||
| GET | `/containers` | Returns information about all Docker containers | None |
| GET | `/names` | Returns a list of all container names | None |
| GET | `/status` | Returns status information for all containers | None |
| **Container Control** ||||
| POST | `/control/:association/:value/start` | Start a container | `:association`: `id` or `name`  `:value`: Container ID or name |
| POST | `/control/:association/:value/stop` | Stop a container | `:association`: `id` or `name`  `:value`: Container ID or name |
| POST | `/control/:association/:value/restart` | Restart a container | `:association`: `id` or `name`  `:value`: Container ID or name |
| **Container Monitoring** ||||
| GET | `/control/:association/:value/logs` | Get container logs | `:association`: `id` or `name`  `:value`: Container ID or name  `?tail=<number>`: Optional query parameter to limit log lines |
| GET | `/control/:association/:value/status` | Get status for a specific container | `:association`: `id` or `name`  `:value`: Container ID or name |

## Compiling

If you want to compile the API to a single executable file, you can use the following command:

```bash
deno task compile
```

This will create a single executable file `docker-control` in the `./bin` directory. You can then run this file to start the API.
