# docker-control

Hivecom network wide Docker container orchestration and metrics API using Hono and Deno.

## Using Docker Control

```bash
# Start the API server (default command)
deno task start

# Show CLI help
deno task start --help

# Display version
deno task start --version
# or
deno task start -v

# Run in silent mode (no console output)
deno task start --silent
# or
deno task start -s

# Output logs to a file
deno task start --log-file /path/to/logfile.log

# Combine options
deno task start --silent --log-file /var/log/docker-control.log
```

From here, you can access the API at `http://localhost:${DOCKER_CONTROL_PORT}` (default: `54320`).

Make sure you set the appropriate `DOCKER_CONTROL_KEY` in your environment variables. This is the key that will be used to authenticate requests to the API.

## API Endpoints

All API requests require the `Authorization` header containing the token matching the `DOCKER_CONTROL_TOKEN` environment variable.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/containers` | Returns information about all Docker containers |
| GET | `/names` | Returns a list of all container names |
| GET | `/status` | Returns status information for all containers |
| POST | `/control/:association/:value/start` | Start a container |
| POST | `/control/:association/:value/stop` | Stop a container |
| POST | `/control/:association/:value/restart` | Restart a container |
| GET | `/control/:association/:value/logs` | Get container logs* |
| GET | `/control/:association/:value/status` | Get status for a specific container |

Specify `:association` as `id` or `name` and `:value` to perform an action on a given container ID or name.  

The `logs` endpoint will return **all** lines of logs from the container. You can specify a limit of lines starting from the end by adding a query parameter `tail=<number>` to the URL. For example, `/control/id/123/logs?tail=50` will return the last 50 lines of logs from the container with ID `123`.

## Development Setup

Make sure Deno is installed on your machine. You can follow the instructions [here](https://deno.land/manual/getting_started/installation) to install Deno.

Once Deno is installed, you can clone this repository and install the dependencies.

```bash
deno install
```

## Compiling

If you want to compile the API to a single executable file, you can use the following command:

```bash
deno task compile
```

This will create a single executable file `docker-control` in the `./bin` directory. You can then run this file to start the API.

The compiled binary includes all the CLI features:

```bash
# Show help
./bin/docker-control --help

# Display version
./bin/docker-control --version

# Run in silent mode with log output
./bin/docker-control --silent --log-file /var/log/docker-control.log
```

### Version Information

You can override this by setting the `DOCKER_CONTROL_VERSION` environment variable before building:

```bash
DOCKER_CONTROL_VERSION=1.2.3 deno task compile
```

## Deployment

### With Systemd

The repository includes systemd configuration files for running docker-control as a service.

1. First, compile the API to a single executable file:

    ```bash
    deno task compile
    ```

2. Run the provided setup script as root:

    ```bash
    sudo ./system/systemd/docker-control-setup.sh
    ```

3. Edit the environment file to set your secure token:

    ```bash
    sudo nano /etc/docker-control/environment
    ```

4. Start and enable the service:

    ```bash
    sudo systemctl enable --now docker-control
    ```

5. Check the service status:

    ```bash
    sudo systemctl status docker-control
    ```

> **Note:** When running as a service, Docker Control runs in silent mode with log output directed to `/var/log/docker-control/app.log`.

### With NGINX

>[!NOTE]
> We're using `control.[host].hivecom.net` as an example for a server in the Hivecom network. You should replace this with your own domain name.

To expose the API through NGINX with HTTPS, you can use the provided NGINX configuration file.

1. Copy the NGINX configuration file to your NGINX sites directory:

    ```bash
    sudo cp ./system/nginx/control.host.hivecom.net.conf /etc/nginx/sites-available/
    ```

2. Create a symbolic link to enable the site:

    ```bash
    sudo ln -s /etc/nginx/sites-available/control.host.hivecom.net.conf /etc/nginx/sites-enabled/
    ```

3. Edit the configuration file to adjust paths and SSL settings for your environment:

    ```bash
    sudo nano /etc/nginx/sites-available/control.host.hivecom.net.conf
    ```

4. Test the NGINX configuration:

    ```bash
    sudo nginx -t
    ```

5. Reload NGINX:

    ```bash
    sudo systemctl reload nginx
    ```

Now your Docker Control API should be accessible at `https://control.host.hivecom.net` with proper SSL encryption.
