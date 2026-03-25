# Infrastructure management

set dotenv-load

# Start Forgejo in Docker
up:
    docker compose up -d forgejo
    @echo "Waiting for Forgejo..."
    @for i in $(seq 1 30); do \
        curl -sf http://localhost:3001/api/v1/version > /dev/null 2>&1 && echo "Forgejo is up!" && break; \
        [ "$i" -eq 30 ] && echo "ERROR: Forgejo didn't start" && exit 1; \
        sleep 1; \
    done

# Stop Forgejo
down:
    docker compose down

# Show Forgejo container status
status:
    docker compose ps

# View Forgejo logs
logs *args:
    docker compose logs forgejo {{ args }}

# Nuke all data and start fresh
reset:
    docker compose down -v
    rm -f redc-dev.db
