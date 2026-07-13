# PortOne Gateway Adapter

Lets the backend swap between PortOne V2 (**active**) and PortOne V1 (legacy
IAMPORT REST, fallback only) without changing call sites. All payment call
sites (`PortoneApplyService`, `PaymentsReconciliationService`,
`RegistrationsService` refunds) depend on the `PORTONE_GATEWAY` Nest token —
never on a concrete gateway.

## Files

- `portone-gateway.interface.ts` — `PortoneGateway` interface + `PORTONE_GATEWAY` Nest token + `NormalizedWebhookEvent` union.
- `portone-v2.gateway.ts` — **active.** Wraps `PortoneVerifyService` (`@portone/server-sdk`, `PORTONE_V2_API_SECRET`) for `getPayment`/`cancelPayment`; `verifyWebhook` verifies the standard-webhooks signature with `PORTONE_WEBHOOK_SECRET` before emitting events.
- `portone-v1.gateway.ts` / `portone-v1.client.ts` / `portone-v1-normalize.ts` — legacy fallback, fully implemented against the IAMPORT REST API (`PORTONE_V1_IMP_KEY`/`PORTONE_V1_IMP_SECRET`). V1 callbacks are unsigned, so `verifyWebhook` only parses identifiers — state changes still require the API re-fetch.
- `portone-gateway.factory.ts` — Nest provider that returns v1 or v2 based on `portone.moduleVersion` config.

## Config (all credentials from `.env` — see `.env.example`)

| Env var | Default | Notes |
| --- | --- | --- |
| `PORTONE_MODULE_VERSION` | `v2` | `v1` or `v2`. Validated by Joi in `env.validation.ts`. Production runs `v2`. |
| `PORTONE_STORE_ID` | — | V2 store id (`store-...`). |
| `PORTONE_CHANNEL_KEY` | — | V2 channel key (`channel-key-...`). One active channel per environment. |
| `PORTONE_V2_API_SECRET` | — | V2 REST API secret (getPayment / cancelPayment). |
| `PORTONE_WEBHOOK_SECRET` | — | V2 webhook signing secret (`whsec_...`). Falls back to `PORTONE_WEBHOOK_SECRET_ARN` (AWS Secrets Manager). |
| `PORTONE_V1_IMP_*`, `PORTONE_V1_PG*` | — | Legacy V1 only; ignored when `v2` is selected. |

## Status

- `v2`: **active in all environments.** Selecting `PORTONE_MODULE_VERSION=v2`
  (or leaving it unset) routes payments through the V2 REST API and signed
  webhooks. The frontend follows automatically: `/payment/request` returns
  `portoneVersion`, and `/apply` Step 4 uses `@portone/browser-sdk/v2`
  `requestPayment` when it says `v2`.
- `v1`: legacy fallback, kept operational for rollback only. Selecting
  `PORTONE_MODULE_VERSION=v1` switches the backend to the IAMPORT REST API and
  the frontend to `iamport.js` (`requestPortoneV1Vbank`). Do **not** select it
  for new environments.

## Switching an environment to V2 (runbook)

1. Set `PORTONE_MODULE_VERSION=v2` in the server `.env` (or delete the line —
   `v2` is the default) and make sure `PORTONE_STORE_ID`,
   `PORTONE_CHANNEL_KEY`, `PORTONE_V2_API_SECRET`, `PORTONE_WEBHOOK_SECRET`
   are set.
2. In the PortOne console, register the webhook under 결제 연동(V2) → 웹훅 관리
   (see the header comment in `portone-webhook.controller.ts`) and copy its
   `whsec_...` secret into `PORTONE_WEBHOOK_SECRET`.
3. Reload the backend (deploys do NOT restart it automatically) and check the
   boot log for the `PaymentsReconciliationService` credential warning — its
   absence means the V2 secret was picked up.
4. Smoke: `npm run smoke:payment` (V2). `smoke:payment:v1` covers the legacy
   path.

**In-flight V1 payments do NOT reconcile after the switch.** Webhook
verification and the 5-minute sweep both use the *active* gateway: the V2 API
cannot resolve a V1 `imp_uid`/`merchant_uid`, and V1's unsigned webhooks fail
V2 signature verification. Before switching, drain PENDING V1 virtual accounts
(let them be paid or expire), or confirm the stragglers manually — check with
`SELECT orderId FROM Payment WHERE status='PENDING'` — while temporarily
flipping back to `v1` if needed.
