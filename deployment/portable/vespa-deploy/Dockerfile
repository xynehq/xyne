FROM curlimages/curl:latest

# Switch to root user to install packages and set permissions
USER root

# Install bash and other necessary tools
RUN apk add --no-cache bash

WORKDIR /app/vespa

# Copy the vespa server code (relative to project root build context)
COPY server/vespa .

# Make the script executable
RUN chmod +x deploy-docker.sh

CMD ["./deploy-docker.sh"]