# AAA Business Consultancy CRM - Testing Guide

This guide provides step-by-step instructions to test all the production architecture modules implemented for the AAA CRM backend.

## 1. Prerequisites: Running Redis
The background queues (BullMQ) require a running Redis instance.
- **Using Docker:** Run `docker run --name aaa-redis -p 6379:6379 -d redis`
- **Using Upstash (Cloud):** Create a free Redis DB on upstash.com and replace `REDIS_URL="redis://127.0.0.1:6379"` in your `.env` file with the Upstash connection string.
- Restart the backend (`npm run dev`). If you don't see `ECONNREFUSED`, Redis is connected successfully!

---

## 2. Testing Webhooks & Lead Generation
### Meta Webhook
1. Open a terminal or Postman.
2. Send a `POST` request to `https://aaa-consultancy-backend-production.up.railway.app/api/v1/webhooks/meta`.
3. **Payload (JSON):**
```json
{
  "object": "page",
  "entry": [{
    "id": "test-123",
    "messaging": [{"message": {"text": "Hello, I want a Spain Visa!"}}]
  }]
}
```
4. **Expected Result:** 
   - Postman receives a `200 OK` instantly with the text `EVENT_RECEIVED`.
   - Your backend terminal logs `Processing communication job test-123`.

---

## 3. Testing the Translation Engine (PDF Word Calculation)
1. Ensure your React frontend is running (`npm run dev` in the frontend folder).
2. Go to: [http://localhost:5173/public/translation](http://localhost:5173/public/translation)
3. Upload any standard `.pdf` file from your PC.
4. Click **"Get Instant Quote"**.
5. **Expected Result:** The backend reads the PDF, counts the words, applies your database rates (e.g. 0.10 EUR/word), and returns the final price on the screen.

---

## 4. Testing the Public Booking Engine & Anti-Fraud
1. Go to: [http://localhost:5173/public/booking/eligibility](http://localhost:5173/public/booking/eligibility)
2. Fill out the form with dummy data and a valid email.
3. Click **"Book Assessment"**.
4. **Expected Result:** 
   - You get a success message.
   - In your database, a `Client`, `Lead`, `ApplicationCycle`, and `Consultation` record are all created.
   - BullMQ schedules a "No-Show Enforcer" job to check the consultation status exactly 10 minutes after the meeting time you selected.

### Testing Anti-Fraud (Cross-Device Blocking)
1. Open your database (via Prisma Studio: run `npx prisma studio` in the backend).
2. Find the `Client` you just created.
3. Set the `isBlocked` flag to `true` and save.
4. Go back to your browser and submit the booking form again using a *completely different name and email*.
5. **Expected Result:** The booking fails with an `Action Required` screen because FingerprintJS detected you are using the same browser/device!

---

## 5. Testing the Payment State Machine (Stripe)
1. Send a simulated Stripe Webhook via Postman to `POST https://aaa-consultancy-backend-production.up.railway.app/api/v1/webhooks/stripe`.
2. **Payload (JSON):**
```json
{
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "txn_test_123",
      "amount_total": 50000,
      "client_reference_id": "<INSERT_A_VALID_PAYMENT_ID_FROM_DATABASE>"
    }
  }
}
```
3. **Expected Result:** 
   - The Payment record in your database updates to `Paid`.
   - The associated `ApplicationCycle` automatically transitions to `Payment Received - Pending Docs`.
   - An immutable `AuditLog` is inserted into the database tracking this state change.

---

## 6. Testing AI Summarization & Redis Caching
1. Ensure the Client you created earlier has a few `CommunicationLog` entries in the database.
2. Send a `POST` request to `https://aaa-consultancy-backend-production.up.railway.app/api/v1/ai/summarize-client`.
3. **Payload (JSON):**
```json
{
  "clientId": "<INSERT_YOUR_CLIENT_ID>"
}
```
4. **Expected Result (First Call):** 
   - Returns a summary of the client's communications.
   - Response includes `"cached": false`.
5. **Expected Result (Second Call):** 
   - Returns instantly without calculating.
   - Response includes `"cached": true`.
6. Add a new `CommunicationLog` to the database for this client and send the request again. The cache will automatically miss, regenerate, and return `"cached": false`.
