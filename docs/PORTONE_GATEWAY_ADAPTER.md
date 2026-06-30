# PortOne Gateway Adapter (Phase 0 scaffold)

Lets the backend swap between PortOne V2 (current) and PortOne V1 (legacy
IAMPORT REST) without changing call sites. Phase 0 wires the seam; V1 is not
yet implemented.

## Files

- `portone-gateway.interface.ts` — `PortoneGateway` interface + `PORTONE_GATEWAY` Nest token + `NormalizedWebhookEvent` union.
- `portone-v2.gateway.ts` — wraps `PortoneVerifyService` for `getPayment`/`cancelPayment` and the existing `@portone/server-sdk/dist/webhook.cjs` verifier for `verifyWebhook`. Behavior matches the current `PortoneApplyService.verifyAndHandleWebhookPayload` parse step.
- `portone-v1.gateway.ts` — stub. All methods throw `NotImplementedException`.
- `portone-gateway.factory.ts` — Nest provider that returns v1 or v2 based on `portone.moduleVersion` config.

## Config

| Env var | Default | Notes |
| --- | --- | --- |
| `PORTONE_MODULE_VERSION` | `v2` | `v1` or `v2`. Validated by Joi in `env.validation.ts`. |
| `PORTONE_CHANNEL_KEY` | — | Reused across versions. One active channel per environment. |

## Status

- `v2`: wired end-to-end. Selecting `PORTONE_MODULE_VERSION=v2` (or unset) is
  byte-identical to today — `PortoneApplyService` still calls
  `PortoneVerifyService` directly.
- `v1`: stub only. Selecting `PORTONE_MODULE_VERSION=v1` does not break boot
  (factory returns the stub), but the first call to any gateway method will
  throw `NotImplementedException`. Do **not** ship `v1` to any env until
  Phases 1–2 land.

## What Phase 0 deliberately does *not* do

- Does not refactor `PortoneApplyService` to inject `PORTONE_GATEWAY`. That is
  Phase 1, gated on V1 impl arriving.
- Does not add a separate V1 webhook controller.
- Does not change the frontend.
- Does not add V1-specific env vars — the existing `PORTONE_CHANNEL_KEY` is
  treated as the active KCP channel for whichever version is selected.

## Next steps (Phases 1–4)

See the implementation prompt in chat. Phase 1: implement
`PortoneV1Gateway.getPayment` + `cancelPayment` against the IAMPORT REST API
and refactor `PortoneApplyService` to depend on `PORTONE_GATEWAY`. Phase 2:
add the V1 webhook controller (or version-detect inside the existing one).
