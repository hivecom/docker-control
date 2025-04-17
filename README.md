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
| GET | `/containers` | Returns information about all Docker containers | None |
| GET | `/names` | Returns a list of all container names | None |
| GET | `/status` | Returns status information for all containers | None |
| POST | `/control/:association/:value/start` | Start a container | `:association`: `id` or `name`  `:value`: Container ID or name |
| POST | `/control/:association/:value/stop` | Stop a container | `:association`: `id` or `name`  `:value`: Container ID or name |
| POST | `/control/:association/:value/restart` | Restart a container | `:association`: `id` or `name`  `:value`: Container ID or name |
| GET | `/control/:association/:value/logs` | Get container logs | `:association`: `id` or `name`  `:value`: Container ID or name  `?tail=<number>`: Optional query parameter to limit log lines |
| GET | `/control/:association/:value/status` | Get status for a specific container | `:association`: `id` or `name`  `:value`: Container ID or name |

## Compiling

If you want to compile the API to a single executable file, you can use the following command:

```bash
deno task compile
```

This will create a single executable file `docker-control` in the `./bin` directory. You can then run this file to start the API.

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

### With NGINX

>[!NOTE]
> We're using `control.[host].hivecom.net` as an example for a server in the Hivecom network. You should replace this with your own domain name.

To expose the API through NGINX with HTTPS, you can use the provided NGINX configuration file.

>[!INFO]
> This configuration includes snippets from [neko-config](https://github.com/catlinman/neko-config/tree/master/nginx) for SSL and security headers. Make sure to adjust the paths to your SSL certificates and keys.

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
