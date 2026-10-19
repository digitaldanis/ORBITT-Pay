# Self-hosted deployment

Docker Compose runs PostgreSQL, the Fastify API, the webhook worker, hosted checkout, and the dashboard. PostgreSQL is the only persistent service; queues and webhook retries use its outbox tables.

## Start the stack

Install Docker Engine with the Compose plugin, then prepare local secrets:

```sh
cp .env.example .env
```

Set `POSTGRES_PASSWORD` to a URL-safe random value (hex is suitable), and set `APP_ENCRYPTION_KEY` to 32 random bytes in base64:

```sh
openssl rand -hex 24
openssl rand -base64 32
```

For a public deployment, also set `CHECKOUT_BASE_URL` to the HTTPS checkout origin. Put a TLS reverse proxy such as Caddy or Traefik in front of the HTTP ports. The compose stack trusts forwarded client IP headers only from its Nginx proxy; do not expose the API container directly to untrusted networks.

Start all services:

```sh
docker compose up --build -d
```

The API waits for PostgreSQL health and applies pending SQL migrations before listening. Nginx serves checkout at `http://localhost:8080`, dashboard at `http://localhost:8081`, and proxies `/v1`, `/docs`, and `/health` to the API. In production, assign the dashboard and checkout separate hostnames and terminate TLS at the front proxy. The worker scans every network that has an endpoint configured (see `.env.example` and [chain watchers](./chain-watchers.md)), updates transfer and confirmation state, expires unpaid invoices and delivers webhook events. Networks without an endpoint are simply not offered at checkout.

Create the first merchant and dashboard login:

```sh
docker compose exec api npm run api-key:create --workspace apps/api -- "Example Shop"
```

Save the printed merchant ID and API key securely. Create the dashboard user by passing its password through the process environment, not as a command-line argument:

```sh
read -s DASHBOARD_USER_PASSWORD
export DASHBOARD_USER_PASSWORD
docker compose exec -e DASHBOARD_USER_PASSWORD api npm run dashboard:user:create --workspace apps/api -- <merchant-uuid> owner@example.com
unset DASHBOARD_USER_PASSWORD
```

The first webhook configuration in dashboard Settings creates a signing secret and shows it once. Keep `APP_ENCRYPTION_KEY` backed up: webhook signing secrets are encrypted with it, and pending deliveries also retain encrypted key snapshots.

## Operations

View service health and logs with `docker compose ps` and `docker compose logs -f api worker`. Restart services with `docker compose restart api worker`. Migrations run automatically on API start and use a PostgreSQL advisory lock.

The `orbitt_postgres` named volume contains merchants, API keys, invoices, derivation indexes, webhook events, attempts, and dashboard sessions. Back it up regularly. A logical backup can be written from the host with:

```sh
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > orbitt-postgres.sql.gz
```

Restore into a compatible PostgreSQL database with:

```sh
gunzip -c orbitt-postgres.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Keep database backups and `APP_ENCRYPTION_KEY` in separate protected storage. Before accepting real payments, make a test payment on every network you enable and keep confirmation counts conservative; transfers removed by a chain reorganization are not rolled back automatically.
