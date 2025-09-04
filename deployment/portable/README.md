# Xyne Portable Deployment

One-click deployment system for Xyne with separated infrastructure and application management.

## Quick Start

```bash
# Start all services
./deploy.sh start

# Access Xyne at http://localhost:3000
```

## Key Features

- **🚀 One-click deployment** - Complete setup with single command
- **⚡ Fast app updates** - Update application without touching database/search (~30s vs 3+ min)
- **🔧 Modular architecture** - Separate infrastructure and application concerns
- **📊 Built-in monitoring** - Grafana, Prometheus, Loki included
- **🔄 Export/Import** - Easy transfer between machines
- **🎯 Auto GPU/CPU detection** - Automatically uses GPU acceleration when available, falls back to CPU-only mode

## Directory Structure

```
portable/
├── docker-compose.yml              # Base configuration
├── docker-compose.infrastructure.yml  # DB, Vespa, monitoring
├── docker-compose.app.yml          # Xyne application only  
├── deploy.sh                       # Deployment management
├── quick-export.sh                 # Export for transfer
├── prometheus-selfhosted.yml       # Metrics config
├── loki-config.yaml               # Logging config
├── promtail-config.yaml           # Log collection config
└── grafana/                       # Dashboard configs
```

## Common Commands

### Deployment
```bash
./deploy.sh start          # Start all services (auto-detects GPU/CPU)
./deploy.sh start --force-cpu    # Force CPU-only mode
./deploy.sh start --force-gpu    # Force GPU mode (if available)
./deploy.sh stop           # Stop all services  
./deploy.sh restart        # Restart everything
./deploy.sh status         # Show service status and GPU/CPU mode
```

### Updates
```bash
./deploy.sh update-app     # Quick app update (30s)
./deploy.sh update-infra   # Update infrastructure
```

### Database Management
```bash
./deploy.sh db-generate    # Generate migrations (after schema changes)
./deploy.sh db-migrate     # Apply pending migrations
./deploy.sh db-studio      # Open Drizzle Studio (localhost:4983)
```

### Monitoring
```bash
./deploy.sh logs           # All service logs
./deploy.sh logs app       # App logs only
./deploy.sh cleanup        # Remove old containers
```

### Export/Import
```bash
./quick-export.sh          # Create portable package
./quick-export.sh --no-export  # Build for same machine
```

## Access URLs

- **Xyne Application**: http://localhost:3000
- **Grafana Dashboard**: http://localhost:3002  
- **Prometheus Metrics**: http://localhost:9090
- **Loki Logs**: http://localhost:3100

## Requirements

### Essential
- Docker Engine 20.10+
- Docker Compose 2.0+
- 8GB+ RAM (16GB+ recommended)  
- 50GB+ disk space

### Optional (for GPU acceleration)
- NVIDIA GPU with CUDA support
- NVIDIA Container Toolkit
- **Note**: System automatically detects GPU availability and falls back to CPU-only mode if needed

## Configuration

1. Copy environment template:
   ```bash
   cp .env.example .env
   ```

2. Add your API keys:
   ```bash
   nano .env
   ```

3. Deploy:
   ```bash
   ./deploy.sh start
   ```

## Documentation

📖 **Complete Documentation**: See [Portable Deployment Guide](../../docs/deployment/advanced/portable-deployment.mdx)

## Advantages Over Simple Docker Compose

| Feature | Simple Compose | Portable Deployment |
|---------|---------------|-------------------|
| App Updates | Full restart (~3+ min) | App-only restart (~30s) |
| Infrastructure Management | Manual | Automated with health checks |
| Monitoring | None | Grafana + Prometheus + Loki |
| Export/Import | Manual | Built-in scripts |
| Production Ready | Basic | Advanced with security |
| Permission Management | Manual | Automated |

## Migration from Simple Compose

1. **Backup current data**:
   ```bash
   cp -r ./server/xyne-data ./backup/
   cp -r ./server/vespa-data ./backup/
   ```

2. **Deploy portable system**:
   ```bash
   cd deployment/portable/
   ./deploy.sh start
   ```

3. **Migrate data** (if needed):
   ```bash
   ./deploy.sh stop
   cp -r ../../backup/* ./data/
   ./deploy.sh start
   ```

## Support

- 📚 [Full Documentation](../../docs/deployment/advanced/portable-deployment.mdx)
- 💬 [Slack Community](https://xynerds.slack.com/)
- 🐛 [GitHub Issues](https://github.com/xynehq/xyne/issues)
- ✉️ [Email Support](mailto:founders@xynehq.com)