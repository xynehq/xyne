# Xyne Setup Guide

This guide provides detailed instructions for setting up and running the Xyne project locally.

## Prerequisites

Before you begin, ensure you have the following tools installed:

- **Homebrew** (macOS package manager)
- **Bun** - JavaScript runtime & package manager
- **OrbStack** - Container runtime
- **Docker** & **Docker Compose**
- **Vespa CLI** - Install via: `brew install vespa-cli`

## Setup Instructions

### 1. Download Project

Download the project folder (referred to as `t` in the original instructions) and extract it to your desired location.

### 2. Environment Configuration

#### Backend Environment Setup
1. Navigate to the backend directory
2. Rename `.env.default` to `.env`
3. Add the following Google OAuth credentials to your backend `.env` file:
   ```env
   GOOGLE_CLIENT_ID=<YOUR_GOOGLE_CLIENT_ID>
   GOOGLE_CLIENT_SECRET=<YOUR_GOOGLE_CLIENT_SECRET>
   GOOGLE_REDIRECT_URI=http://localhost:3000/v1/auth/callback
   ```

#### Frontend Environment Setup
1. Navigate to the frontend directory
2. Rename `.env.default` to `.env`

#### Port Configuration
**Important**: Change port `3001` to `3000` in both frontend and backend `.env` files.

### 3. Install Bun

Run the following command in the xyne folder:
```bash
curl -fsSL https://bun.sh/install | bash
```

### 4. Configure Shell Environment

1. Source your shell configuration:
   ```bash
   source ~/.zshrc
   ```

2. If `.zshrc` file is not found, create/edit it:
   ```bash
   vim ~/.zshrc
   ```

3. Add the following lines to `.zshrc`:
   ```bash
   export BUN_INSTALL="$HOME/.bun"
   export PATH="$BUN_INSTALL/bin:$PATH"
   ```

### 5. Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   bun i
   ```

3. Start the development server:
   ```bash
   bun run dev
   ```

### 6. Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd server
   ```

2. Start Docker containers:
   ```bash
   docker-compose -f deployment/docker-compose.dev.yml up
   ```

3. Install dependencies:
   ```bash
   bun i
   ```

4. Generate database schema:
   ```bash
   bun run generate
   ```

if error generating remove migrations one  `rm -rf migrations` then try again

5. Run database migrations:
   ```bash
   bun run migrate
   ```

### 7. Vespa Setup

1. Ensure Vespa CLI is installed:
   ```bash
   brew install vespa-cli
   ```

2. Navigate to the Vespa directory:
   ```bash
   cd server/vespa
   ```

3. Deploy Vespa:
   ```bash
   ./deploy.sh
   ```

## Database Management

### Accessing the Database

1. Connect to the database container:
   ```bash
   docker exec -it xyne-db bash
   ```

2. Access PostgreSQL:
   ```bash
   psql -U xyne
   ```

### Useful Database Commands

- List all tables:
  ```sql
  \d
  ```

- To truncate tables (if needed):
  ```sql
  TRUNCATE TABLE table_name;
  ```

## Project Structure

```
xyne/
├── frontend/          # Frontend application
├── server/           # Backend server
│   ├── vespa/       # Vespa search configuration
│   └── deployment/  # Docker configurations
└── shared/          # Shared utilities
```

## Troubleshooting

### Common Issues

1. **Port conflicts**: Ensure ports 3000 are not in use by other applications
2. **Docker issues**: Make sure Docker Desktop or OrbStack is running
3. **Permission errors**: You may need to use `sudo` for some Docker commands
4. **Bun not found**: Ensure you've sourced your shell configuration after installing Bun

### Getting Help

If you encounter any issues during setup, please:
1. Check that all prerequisites are properly installed
2. Verify environment variables are correctly set
3. Ensure Docker services are running
4. Review error logs for specific issues

## Next Steps

Once everything is running:
- Frontend will be available at: `http://localhost:5173` for dev mode else `http://localhost:3000` for build
- Backend API will be accessible at: `http://localhost:3000/v1`
- You can start developing and testing the application

## License

See LICENSE file in the project root for license information.
