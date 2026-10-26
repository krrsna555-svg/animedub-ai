# AnimeDub AI

Mobile-first AnimeDub AI starter with:
- Anime metadata search via AniList (not episode video streams)
- Email/password registration and login
- HttpOnly cookie sessions and hashed passwords
- Private per-user project list
- Authorized video upload endpoint
- Free-plan limit of 3 successfully completed jobs per UTC day (counts completed jobs; real processor must set completion state)
- Example Pro pricing display
- Admin-only stats endpoint
- Subscription-expiry cleanup job
- Explicit status that AI dubbing and payments are not configured

## Run locally / in a Node-capable Replit project

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env`.
3. Set `JWT_SECRET` to a random secret at least 32 characters long.
4. Optionally set `ADMIN_EMAIL` before registering the first account you want to be the admin.
5. Run `npm install`.
6. Run `npm start`.
7. Open the web preview on port 3000.

In Replit, use the Shell to install packages and run `npm start`, or configure the project to use this start script. Replit's available project setup can vary.

## Important production work still required

This is a foundation, not a fully operational AI dubbing business.

- Add a real asynchronous job queue and worker.
- Integrate transcription, translation, TTS/voice generation, audio separation if licensed/available, FFmpeg, synchronization, and output export.
- Update job status to `processing`, `completed`, or `failed` from the worker and set `completed_at` only after a real successful export. The current upload endpoint deliberately does not mark jobs complete.
- Add a real payment provider and verify signed server-side webhooks before enabling Pro. Do not activate plans based on client claims or payment screenshots.
- Add an email provider and a scheduled reminder job for 7, 3, and 1 days before expiry, plus expiry-day notification. The expiry cleanup in this starter runs inside the web process and is not a durable scheduler.
- Use managed database and private object storage in production; SQLite and local disk may be ephemeral or unsuitable on some hosts.
- Add CSRF protection appropriate to the cookie/session architecture, email verification, password reset, account deletion, privacy policy, terms, audit logging, upload malware scanning, and strict resource quotas.
- The app does not scrape protected streaming sites or retrieve protected episode streams. Use only video you own or are authorized to process.
- Do not expose admin access or real user data in public screenshots.
- Pro prices are examples and payment activation is intentionally disabled.
- Hosting and AI processing are not guaranteed to be permanently free.


## UPI QR payment display

The pricing page displays the user-provided UPI QR image and UPI ID `7088075379@fam`. The QR image is stored at `public/assets/parent-upi-qr.jpg`. Payment verification and subscription activation are intentionally not implemented; do not treat a screenshot or client-side form as proof of payment. A parent/guardian should confirm receipt and an authorized admin should activate any subscription. Verify the recipient name and amount in the UPI app before approving a payment.
