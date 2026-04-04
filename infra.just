# Infrastructure management

set dotenv-load

DEV_COMPOSE := "infra/compose/dev.yml"

# Start the full local stack in Docker
up:
    docker compose -f {{ DEV_COMPOSE }} up -d --build
    @echo "Waiting for API..."
    @for i in $(seq 1 30); do \
        curl -sf http://localhost:3000/health > /dev/null 2>&1 && echo "API is up!" && break; \
        [ "$i" -eq 30 ] && echo "ERROR: API didn't start" && exit 1; \
        sleep 1; \
    done

# Stop the full local stack
down:
    docker compose -f {{ DEV_COMPOSE }} down

# Show container status
status:
    docker compose -f {{ DEV_COMPOSE }} ps

# View logs for one or more services
logs *args:
    docker compose -f {{ DEV_COMPOSE }} logs {{ args }}

# Nuke all data and start fresh
reset:
    docker compose -f {{ DEV_COMPOSE }} down -v
    rm -f .env
