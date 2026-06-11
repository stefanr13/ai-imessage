# Cloudflare Tunnel Setup

The phone app should not talk directly to the Mac mini over an open LAN port when
you are away from home. Use Cloudflare Tunnel to publish only the mobile bridge:

```text
public hostname -> Cloudflare Tunnel -> http://127.0.0.1:8788
```

The mobile bridge still requires the bearer token from `config/mobile-bridge.env`
for every mobile endpoint. Keep that file local and private.

## Recommended Path

Use a dashboard-managed Cloudflare Tunnel:

1. In Cloudflare Zero Trust, create a tunnel for this Mac mini.
2. Add a public hostname route for the tunnel.
3. Set the service URL to:

```text
http://127.0.0.1:8788
```

4. Copy the tunnel token into a local gitignored env file:

```bash
cp config/cloudflare-tunnel.env.example config/cloudflare-tunnel.env 2>/dev/null || true
$EDITOR config/cloudflare-tunnel.env
```

The file should contain:

```bash
CLOUDFLARE_TUNNEL_TOKEN=replace-with-cloudflare-token
```

Start the tunnel:

```bash
./scripts/start-cloudflare-tunnel-background.sh
```

Stop it:

```bash
./scripts/stop-cloudflare-tunnel-background.sh
```

## Locally Managed Tunnel

If you want the CLI to manage the tunnel and DNS route, sign in first:

```bash
./.bin/cloudflared tunnel login
```

Then create the tunnel and route a hostname you control in Cloudflare:

```bash
./.bin/cloudflared tunnel create messages-assistant
./.bin/cloudflared tunnel route dns messages-assistant messages.example.com
```

Create `config/cloudflared/config.yml`:

```yaml
tunnel: messages-assistant
credentials-file: /Users/stefan/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: messages.example.com
    service: http://127.0.0.1:8788
  - service: http_status:404
```

Then create `config/cloudflare-tunnel.env`:

```bash
CLOUDFLARE_TUNNEL_NAME=messages-assistant
CLOUDFLARE_TUNNEL_CONFIG=/Users/stefan/Documents/Codex/2026-06-09/install-ollama-gemma-4-12b-to/work/ai-imessage/config/cloudflared/config.yml
```

Start it with the same background script.

## Phone App Pairing

After the tunnel is running, the phone app should call:

```text
https://<your-cloudflare-hostname>/mobile/bootstrap
```

with:

```text
Authorization: Bearer <BRIDGE_TOKEN>
```

The bootstrap response tells the app which API version, endpoints, contacts,
approval gates, and voice stack recommendation the Mac mini currently supports.

## Production Notes

- Publish only port `8788`, not the dashboard on `8787`.
- Keep Cloudflare Access enabled if you want an additional identity gate.
- Keep the app bearer token even when Cloudflare Access is enabled.
- Do not commit `config/mobile-bridge.env`, `config/cloudflare-tunnel.env`, or
  `config/cloudflared/`.
- Rotate both the Cloudflare tunnel token and `BRIDGE_TOKEN` if a phone is lost.
