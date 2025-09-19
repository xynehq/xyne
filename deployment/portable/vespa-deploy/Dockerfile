FROM vespaengine/vespa:latest

# Switch to root user to install packages and set permissions
USER root

# Install required packages for bun installation
RUN dnf -y install curl unzip

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Switch back to vespa user
USER vespa

WORKDIR /app/vespa

# Copy the vespa server code (relative to project root build context)
COPY server/vespa .

# Make the script executable
RUN chmod +x deploy-docker.sh

CMD ["./deploy-docker.sh"]