# Infrastructure management

set dotenv-load

# Start the full local stack in Docker
up:
    docker compose up -d --build
    @echo "Waiting for Forgejo..."
    @for i in $(seq 1 30); do \
        curl -sf http://localhost:3001/api/v1/version > /dev/null 2>&1 && echo "Forgejo is up!" && break; \
        [ "$i" -eq 30 ] && echo "ERROR: Forgejo didn't start" && exit 1; \
        sleep 1; \
    done

# Stop the full local stack
down:
    docker compose down

# Show container status
status:
    docker compose ps

# View logs for one or more services
logs *args:
    docker compose logs {{ args }}

# Nuke all data and start fresh
reset:
    docker compose down -v
    rm -f .env
