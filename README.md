# Varen WhatsApp Bot

WhatsApp assistant for Varen (varen.life), built from *Varen Life WhatsApp Bot – Customer Journey v0.2*.

- New customers: welcome → service menu (Tailoring, Home Renovation, Designer Services, Concierge) → intro + FAQs → Explore / Submit a Request / Talk to Support
- Existing customers (recognised by WhatsApp number): Book a New Service / My Bookings / Customer Support
- Typed questions answered by Claude **only** from `src/content.js` and the customer's records
- Handover to a person when the bot can't help, the customer asks, or a support issue needs action
- Team inbox at `/agent` where staff reply on the same WhatsApp chat and hand back to the bot

Works with **SmartPing (Pinbot)** — set `SMARTPING_API_KEY`, `PHONE_NUMBER_ID`, `WEBHOOK_KEY` — or Meta's Cloud API directly.

No packages to install. Needs Node.js 20 or newer.

| Command | What it does |
|---|---|
| `npm run chat` | Chat with the bot in your terminal as a new customer (no accounts needed) |
| `npm run chat -- 919999900001` | Same, as existing customer "Rahul" |
| `npm test` | Automatic check of all journeys |
| `npm run check` | Checks your SmartPing key and phone number ID (add `-- 919XXXXXXXXX` to also send a test message) |
| `npm start` | Run the real server |

## Files you will edit

| File | Why |
|---|---|
| `src/content.js` | All bot wording, services, FAQs, website links. Replace every `DRAFT` answer. |
| `.env` (copy of `.env.example`) or Render "Environment" | Secret keys and settings |
| `data/sample-customers.json` | Test customers, only used while `CRM_API_URL` is empty |

## Files you normally don't touch

`server.js` (web server, webhook, inbox API) · `src/flow.js` (the journey logic) · `src/ai.js` (Claude) · `src/whatsapp.js` (sending messages) · `src/crm.js` (customer lookup) · `src/store.js` (saves chats to `data/db.json`) · `public/agent.html` (team inbox page)

## Connecting Varen's real customer database

Ask your backend developer to provide one endpoint:

```
GET {CRM_API_URL}/customer?phone=919876543210
Authorization: Bearer {CRM_API_KEY}

200 → { "name": "Rahul Sharma", "email": "...",
        "bookings": [ { "ref": "VR-1023", "service": "Tailoring",
                        "status": "Completed", "date": "2026-09-14",
                        "details": "..." } ] }
404 → not a customer
```

See the step-by-step guide for full setup instructions.
