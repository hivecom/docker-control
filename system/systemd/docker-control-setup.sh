#!/bin/bash
# docker-control-setup.sh
# This script helps with setting up the docker-control service

# Create required directories
mkdir -p /opt/docker-control
mkdir -p /etc/docker-control

# Create environment file
cat > /etc/docker-control/environment << EOF
# Docker Control API environment variables
# Set your secure token here
DOCKER_CONTROL_TOKEN=your_secure_token_here
EOF

# Secure the environment file
chmod 600 /etc/docker-control/environment

# Create the docker-control user if it doesn't exist
if ! id "docker-control" &>/dev/null; then
    useradd -r -s /bin/false -d /opt/docker-control docker-control
    usermod -aG docker docker-control
fi

# Copy binary to the proper location
cp ./bin/docker-control /usr/local/bin/
chmod +x /usr/local/bin/docker-control

# Copy systemd service file
cp ./system/systemd/docker-control.service /etc/systemd/system/

# Reload systemd to recognize the new service
systemctl daemon-reload

echo "Docker Control API setup completed."
echo "Please edit /etc/docker-control/environment to set your secure token."
echo "Then start the service with: systemctl start docker-control"
echo "Enable it on boot with: systemctl enable docker-control"
