# OpenNova render relay

Lets an OpenNova user generate a [garden render](../docs/guide/garden-render.md)
without their own OpenAI account. They paste a token into **Settings → 3D
render**; their server posts the composite here; this relay spends one credit
and forwards the call with the project's key. The key never leaves this host,
and the composite is passed straight through, never stored.

## Run it

```bash
cp .env.example .env     # fill in OPENAI_API_KEY and a long random ADMIN_KEY
docker compose up -d --build
```

Put it behind the reverse proxy on a path or hostname the users' servers can
reach, and point `RENDER_RELAY_URL` in their OpenNova server at it (the default
is `https://downloads.ramonvanbruggen.nl/render`).

## Hand out credits

```bash
# a new token with 10 renders
curl -s -X POST https://<host>/admin/tokens -H "X-Admin-Key: $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"credits":10,"note":"sponsor: alice"}'

# top the same token up later
curl -s -X POST https://<host>/admin/tokens -H "X-Admin-Key: $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"token":"opennova-…","credits":10}'

# what is out there
curl -s https://<host>/admin/tokens -H "X-Admin-Key: $ADMIN_KEY"
```

The token is shown once, when it is minted; the store only keeps its SHA-256,
so a leaked backup cannot be spent.

## What it protects against

- **Runaway cost**: a credit is spent before the upstream call, refunded when
  that call fails. Per token 20 renders a day, and `DAILY_TOTAL_CAP` (200)
  across all tokens.
- **Big uploads**: `MAX_IMAGE_BYTES`, 12 MB by default.
- **Guessing the admin key**: compared in constant time.

It does not do payments. Hand tokens to sponsors or donors yourself; selling
credits would make this a shop, with the VAT and terms that come with it.
