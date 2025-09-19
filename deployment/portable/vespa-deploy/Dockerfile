FROM vespaengine/vespa:latest

# Switch to root user to install packages and set permissions
USER root

# Install required packages for bun installation
RUN dnf -y install curl unzip

# Install bun globally
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun

WORKDIR /app/vespa

# Copy the vespa server code (relative to project root build context)
COPY server/vespa .

# Make the script executable and ensure vespa user owns the directory
RUN chmod +x deploy-docker.sh && \
    chown -R vespa:vespa /app/vespa

# Switch back to vespa user
USER vespa

# Override the default entrypoint to run our script directly
ENTRYPOINT []
CMD ["./deploy-docker.sh"]