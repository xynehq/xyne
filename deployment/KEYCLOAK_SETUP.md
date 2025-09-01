# XYNE Keycloak Integration - Docker Compose Setup

## Overview

XYNE now includes integrated Keycloak authentication as part of the development Docker Compose stack. This provides a unified development environment with persistent authentication data.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   XYNE Server   │    │    Keycloak     │    │   PostgreSQL    │
│   Port: 3000    │◄──►│   Port: 8081    │◄──►│   Port: 5432    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │                       │
                                │                       ├─ xyne DB
                                │                       └─ keycloak DB
                                │
                        ┌─────────────────┐
                        │   Monitoring    │
                        │ Grafana: 3002   │
                        │ Prometheus: 9090│
                        │ Loki: 3100      │
                        └─────────────────┘
```

## Services

| Service | Container Name | Ports | Purpose |
|---------|---------------|-------|---------|
| PostgreSQL | xyne-db | 5432 | Database for both XYNE and Keycloak |
| Keycloak | xyne-keycloak | 8081→8080 | Authentication server |
| Vespa | vespa | 8080, 19071 | Search engine |
| Prometheus | xyne-prometheus | 9090 | Metrics collection |
| Grafana | xyne-grafana | 3002→3000 | Monitoring dashboards |
| Loki | loki | 3100 | Log aggregation |

## Quick Start

### Development Environment

#### 1. Start All Services
```bash
cd deployment/
docker-compose -f docker-compose.dev.yml up -d
```

#### 2. Initialize Keycloak
```bash
./setup-keycloak.sh
```

#### 3. Start XYNE Server
```bash
cd ../server/
KEYCLOAK_ENABLED=true \
KEYCLOAK_BASE_URL=http://localhost:8081 \
KEYCLOAK_DEFAULT_REALM=xyne-shared \
KEYCLOAK_CLIENT_ID=oa-backend \
KEYCLOAK_CLIENT_SECRET=<your-client-secret> \
bun run dev
```

### Production Environment

#### 1. Set Environment Variables
```bash
# Required for production
export KEYCLOAK_ADMIN=your-admin-username
export KEYCLOAK_ADMIN_PASSWORD=your-secure-password
export POSTGRES_USER=xyne
export POSTGRES_PASSWORD=your-db-password
export KEYCLOAK_PORT=8081  # Optional, defaults to 8081
export KC_LOG_LEVEL=WARN   # Optional, defaults to INFO
```

#### 2. Start Production Stack
```bash
cd deployment/
docker-compose -f docker-compose.prod.yml up -d
```

#### 3. Initialize Keycloak (First Time Only)
```bash
# Wait for Keycloak to start, then run
./setup-keycloak.sh
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KEYCLOAK_ENABLED` | `false` | Enable Keycloak authentication |
| `KEYCLOAK_BASE_URL` | `http://localhost:8081` | Keycloak server URL |
| `KEYCLOAK_DEFAULT_REALM` | `xyne-shared` | Default realm name |
| `KEYCLOAK_CLIENT_ID` | `oa-backend` | Client ID for XYNE |
| `KEYCLOAK_CLIENT_SECRET` | *(required)* | Client secret from Keycloak |

### Default Configuration

- **Admin Console**: http://localhost:8081/admin/
  - Username: `admin`
  - Password: `admin`

- **Realm**: `xyne-shared`
- **Client**: `oa-backend`
- **Test User**: `debojyoti.mandal@juspay.in` / `*`

## Authentication Flow

XYNE supports three authentication methods:

1. **Google OAuth** (existing)
2. **Keycloak SSO** (browser redirect)
3. **Email/Password** (direct login via Keycloak)

### API Endpoints

- `POST /api/keycloak/login` - Email/password authentication
- `GET/POST /api/keycloak/callback` - OAuth callback handler
- `POST /api/keycloak/refresh` - Token refresh
- `POST /api/keycloak/logout` - Logout and token revocation

## Database Setup

### Shared PostgreSQL Configuration

The setup uses a single PostgreSQL instance with separate databases:

- `xyne` - Main application database
- `keycloak` - Keycloak authentication data

### Data Persistence

All data is persisted in Docker volumes:
- PostgreSQL data: `../server/xyne-data`
- Keycloak configuration is stored in the PostgreSQL database

## Development Workflow

### Starting Development Environment

1. **Full Stack**:
   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ./setup-keycloak.sh  # Only needed once
   ```

2. **XYNE Server**:
   ```bash
   # With Keycloak enabled
   export KEYCLOAK_ENABLED=true
   export KEYCLOAK_CLIENT_SECRET=<secret-from-setup>
   bun run dev
   ```

### Testing Authentication

```bash
# Email/Password Login
curl -X POST 'http://localhost:3000/api/keycloak/login' \
  -H 'Content-Type: application/json' \
  -d '{"email": "debojyoti.mandal@juspay.in", "password": "*"}'

# Test /me API
curl 'http://localhost:3000/api/v1/me' \
  -H 'Cookie: access-token=<token>'
```

## Enhanced /me API

The `/me` API now includes Keycloak-specific information when authenticated via Keycloak:

```json
{
  "user": {
    "email": "user@example.com",
    "name": "User Name",
    "role": "SuperAdmin",
    "email_verified": false,
    "preferred_username": "user@example.com",
    "given_name": "User",
    "family_name": "Name",
    "realm_access": {
      "roles": ["offline_access", "uma_authorization"]
    },
    "resource_access": {
      "account": {
        "roles": ["manage-account", "view-profile"]
      }
    },
    "scope": "openid email profile"
  },
  "workspace": { ... },
  "authMethod": "keycloak"
}
```

## Troubleshooting

### Common Issues

1. **Database Connection Error**
   ```bash
   # Recreate keycloak database
   docker exec xyne-db psql -U xyne -c "CREATE DATABASE keycloak;"
   docker restart xyne-keycloak
   ```

2. **Client Secret Missing**
   ```bash
   # Get client secret from Keycloak
   ./setup-keycloak.sh  # Shows secret in output
   ```

3. **Service Not Starting**
   ```bash
   # Check logs
   docker logs xyne-keycloak
   docker logs xyne-db
   ```

### Health Checks

```bash
# Keycloak
curl http://localhost:8081/

# PostgreSQL
docker exec xyne-db psql -U xyne -c "SELECT 1;"

# XYNE Integration
curl http://localhost:3000/api/keycloak/config
```

## Migration from Standalone

If migrating from a standalone Keycloak setup:

1. Export realm configuration from old instance
2. Stop standalone container: `docker stop keycloak-demo`
3. Start integrated stack: `docker-compose up -d`
4. Run setup script: `./setup-keycloak.sh`
5. Import realm configuration if needed

## Production vs Development

### Key Differences

| Feature | Development | Production |
|---------|-------------|------------|
| **Keycloak Mode** | `start-dev` (hot reload) | `start --optimized` (faster startup) |
| **Container Name** | `xyne-keycloak` | `xyne-keycloak-prod` |
| **Resource Limits** | None | 1GB RAM, 0.5 CPU |
| **Cache Strategy** | Simple | Kubernetes clustering ready |
| **Health Checks** | Basic | Extended with longer startup time |
| **Logging** | DEBUG friendly | INFO/WARN levels |

### Production Optimizations

The production configuration includes:

- **`--optimized` mode**: Faster startup and runtime performance
- **Resource limits**: Memory and CPU constraints for container orchestration
- **Extended health checks**: 120s startup period for optimization phase
- **Production cache**: Infinspan with Kubernetes clustering support
- **Environment-based configuration**: All sensitive data via environment variables

## Production Considerations

For production deployment:

1. **Security**:
   - Change default admin credentials via environment variables
   - Use proper client secrets
   - Enable HTTPS with reverse proxy
   - Configure proper CORS origins

2. **Database**:
   - Use separate PostgreSQL instance for Keycloak in large deployments
   - Configure proper backup strategies
   - Set up database clustering if needed

3. **Scaling**:
   - Configure Keycloak clustering with shared database
   - Use external load balancer
   - Set proper resource limits and requests

4. **Monitoring**:
   - Enable Keycloak metrics integration with Prometheus
   - Set up proper logging levels
   - Configure health check monitoring

## Benefits of Integrated Setup

✅ **Development Efficiency**
- Single command starts entire stack
- Consistent environment across team
- Proper service networking

✅ **Data Persistence**
- PostgreSQL backend for Keycloak
- Survives container restarts
- Easy backup/restore

✅ **Team Collaboration**
- Version-controlled configuration
- Consistent realm/client setup
- Shared development environment

✅ **Production Parity**
- Similar architecture to production
- Proper database integration
- Service discovery patterns