# Mobile App Readiness

## Voice Model Choice

Use Argmax Open-Source SDK / WhisperKit as the first on-device speech-to-text
implementation for the iPhone app.

Reasons:

- Native Swift package for Apple platforms.
- Uses Whisper-family Core ML models on Apple Silicon.
- Open-source SDK path, with WhisperKit for speech-to-text and optional TTSKit
  and SpeakerKit later.
- Better iOS integration surface than a custom C++ bridge.
- Keeps "Say this" dictation audio on-device by default.

Fallback:

- `whisper.cpp` remains the fallback if WhisperKit integration blocks. It is
  mature, portable, open source, supports quantized Whisper models, and supports
  Core ML encoder acceleration on Apple hardware.

Do not use Picovoice Leopard/Cheetah as the default open-source path. They are
useful production products, but the required access-key/licensing model makes
them a weaker fit for the first privacy-first local app.

Initial mobile STT target:

- `openai_whisper-base` or equivalent WhisperKit Core ML base model.
- Upgrade to small/distil only after measuring latency and battery on the actual
  phone.

## Mac Bridge

The phone should talk to the dedicated mobile bridge, not the local dashboard
server:

```bash
./scripts/start-mobile-bridge-background.sh
```

This starts `server.mjs` in a separate `screen` session:

- default host: `0.0.0.0`
- default port: `8788`
- token file: `config/mobile-bridge.env`
- log file: `data/mobile-bridge.service.log`

The token file is local-only and gitignored. Use the printed LAN URL and token
when pairing the iPhone app.

## Mobile API Contract

All mobile endpoints require:

```http
Authorization: Bearer <BRIDGE_TOKEN>
```

Startup:

```http
GET /mobile/bootstrap
```

Returns:

- API version
- LAN URLs
- endpoint paths
- send gate status
- configured contacts for manual sends
- monitor summary
- approval status summary
- voice stack recommendation

Contact list:

```http
GET /mobile/contacts
```

Approval queue:

```http
GET /approvals?status=open
GET /approvals/:id
POST /approvals/:id/approve
POST /approvals/:id/reject
POST /approvals/:id/context
```

Manual send:

```http
POST /send
{
  "conversationSlug": "andrea",
  "text": "exact text",
  "confirm": false
}
```

Use `confirm: false` for the first mobile app flow. It creates a pending
manual-send approval. Use `confirm: true` only for an explicit final-send button
after showing the exact recipient and exact text.

## First App Scope

Build the first SwiftUI app with:

- pairing screen for bridge URL and token
- approval inbox
- approval detail with exact proposed text
- approve/send, edit/send, reject
- add-context text/voice response
- manual send composer with configured-contact picker
- local dictation using WhisperKit

Push notifications should come after the first working app. Start with
foreground polling, then add background refresh or APNs once the approval UX is
stable.
