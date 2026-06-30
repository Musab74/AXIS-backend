# PortOne virtual account E2E (test mode)

## Prerequisites

- Backend: `PORTONE_STORE_ID`, `PORTONE_CHANNEL_KEY`, `PORTONE_V2_API_SECRET`
- Webhook: `PORTONE_WEBHOOK_SECRET` **or** `PORTONE_WEBHOOK_SECRET_ARN` (AWS Secrets Manager)
- Frontend: `VITE_PORTONE_STORE_ID`, `VITE_PORTONE_CHANNEL_KEY` (optional; backend `/payment/request` also returns them)
- Do **not** set `VITE_APPLY_KCP_DEMO=true` for the real PortOne flow

## A. Issue virtual account (browser)

1. Start backend (`:3333`) and frontend (`:5173`).
2. Log in → `/apply` → complete steps through payment.
3. Select bank + consent → **가상계좌 발급받기**.
4. Complete PortOne test UI → `/apply/complete` shows account details.

### DB after `/payment/request`

```sql
SELECT id, order_id, payment_key, status, amount
FROM payments WHERE registration_id = '<regId>' ORDER BY created_at DESC LIMIT 1;
-- status=PENDING, order_id like AXIS-<regId>-%

SELECT id, status, seat_held_until FROM registrations WHERE id = '<regId>';
-- status=PENDING_PAYMENT
```

### DB after SDK + `/payment/confirm`

```sql
SELECT payment_key, method, status, raw_response IS NOT NULL AS has_raw
FROM payments WHERE registration_id = '<regId>' ORDER BY created_at DESC LIMIT 1;
-- payment_key set, method=VBANK, status still PENDING, raw_response populated
```

## B. Simulate deposit webhook (local)

1. `ngrok http 3333`
2. PortOne console → register `https://<id>.ngrok.io/api/webhooks/portone`
3. Subscribe: `Transaction.Paid`, `Transaction.Cancelled`, `Transaction.Failed`, `Transaction.VirtualAccountIssued`
4. Use PortOne sandbox deposit simulation for the issued VA, or replay a signed webhook payload.

### DB after `Transaction.Paid`

```sql
SELECT status, approved_at FROM payments WHERE order_id = '<merchantId>';
-- status=CONFIRMED

SELECT status, seat_held_until, exam_deadline FROM registrations WHERE id = '<regId>';
-- status=PAID, seat_held_until=NULL
```

## C. Idempotency

- Repeat `POST /payment/confirm` with same ids → `200`, same VA fields.
- Replay `Transaction.Paid` webhook → no duplicate registration updates.

## API routes (Nest, no `/api` prefix)

| Method | Path |
|--------|------|
| POST | `/payment/request` |
| POST | `/payment/confirm` |
| POST | `/webhooks/portone` |

Vite dev proxies `/api/*` → backend without prefix.
