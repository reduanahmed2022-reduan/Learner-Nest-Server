# LearnNest — Server

LearnNest is an education marketplace where **instructors publish courses** and **students discover them, apply to join, and learn**. This repository is the REST API: Express 5 + MongoDB (`LearnNest` database) + JWT/BetterAuth authentication + Stripe subscriptions + hosted image uploads.

> **Live (replace with your own deployments after shipping):**
> Client: `https://learnnest-client.vercel.app` · API: `https://learnnest-api.onrender.com`
> These URLs are placeholders — update `CLIENT_URL`, `BETTER_AUTH_URL` and your Stripe webhook endpoint after deployment.

## Demo credentials

Run `npm run seed` first. Accounts are created idempotently; re-running the seed does **not** reset passwords or enrollment decisions.

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@mentorlagbe.com` (or `ADMIN_EMAIL`) | `Admin@12345` (or `ADMIN_PASSWORD`) |
| Instructor | `sarah@learnnest.app` | `Tutor@12345` |
| Student | `student1@learnnest.app` | `Tutor@12345` |

The seed also creates a second instructor, a second student, **12 approved courses** across Mathematics, Programming, IELTS, Music, Physics, Language, Chemistry and Biology, plus one **pending** and one **rejected** course for the admin moderation queue, sample enrollments (accepted/pending) and three paid transactions.

## Key features

- **Auth** — JWT register/login (`student` / `instructor` roles), `GET`/`PUT /api/auth/me`, plus BetterAuth mount at `/api/better-auth`.
- **Courses** — public catalog with search, category/level/mode filters and pagination; instructors create/edit/toggle/delete their own courses; new courses start `pending` until admin review.
- **Enrollments** — students apply once per course and may cancel a pending request or restore a rejected one; instructors accept/reject applicants for their courses.
- **Admin** — dashboard stats, user list, role changes and transaction history; admin-only course approval queue.
- **Subscriptions** — Stripe Checkout in `subscription` mode: $15/month for instructors, $10/month for students. Pro instructors get unlimited courses; free instructors can publish two.
- **Payments integrity** — signed metadata, amount/currency validation, idempotent activation, unique Stripe session/invoice keys, renewal recording and cancellation downgrade via signed webhooks.
- **Image uploads** — authenticated, signature-checked 5 MB uploads via ImgBB with a Cloudinary unsigned fallback.
- **Operations** — `/health` endpoint, environment checker, seed script, Render and Vercel deployment configs.

## npm packages

| Package | Purpose |
| --- | --- |
| `express` (5) | HTTP server and router |
| `mongodb` (7) | Native MongoDB driver, connection pool and indexes |
| `stripe` (23) | Checkout Sessions, retrieval and webhook signature verification |
| `multer` (2.5) | In-memory multipart image handling |
| `bcryptjs` | Password hashing for seeded/local accounts |
| `jsonwebtoken` | Signed HS256 access tokens |
| `dotenv` | `.env` loading |
| `cors` | Browser origin allowlist (`CLIENT_URL`) |
| `better-auth` (+ `@better-auth/mongo-adapter`) | Alternative OAuth/session auth mounted on the same `users` collection |

## Quick start

```bash
cd server
npm ci                       # or npm install
cp .env.example .env         # fill in the values (see table below)
npm run verify:env           # key names/status only, never secrets
npm run seed                 # optional: demo admin, instructors, students, courses
npm run dev                  # node --watch index.js
```

The API listens on `PORT` (default `5000`). Verify it with:

```bash
curl http://localhost:5000/health
```

Production: `npm start`. On Render, `render.yaml` runs `npm ci` + `npm start` and checks `/health`. On Vercel, `vercel.json` builds `index.js` with `@vercel/node`.

For Stripe webhooks, point the Stripe Dashboard endpoint at `https://<your-api>/api/payments/webhook` and subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid` and `customer.subscription.deleted`. Use the signing secret as `STRIPE_WEBHOOK_SECRET` — unsigned requests are rejected.

## Environment variables

`npm run verify:env` reports each key as `PRESENT` or `MISSING` without printing values and exits `1` only when a required key is missing.

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB Atlas SRV URI (or local `mongodb://` URI) |
| `JWT_SECRET` | Yes | Long random secret used to sign HS256 tokens |
| `BETTER_AUTH_SECRET` | Yes | Secret for BetterAuth session/OAuth handling |
| `BETTER_AUTH_URL` | No | Public API origin, e.g. `http://localhost:5000` |
| `CLIENT_URL` | No | Browser origin(s), comma separated; Stripe redirects use one canonical URL |
| `STRIPE_SECRET_KEY` | No | Stripe secret key; payments return `503` when absent |
| `STRIPE_WEBHOOK_SECRET` | No | Webhook signing secret; webhook returns `503` when absent |
| `IMGBB_API_KEY` | No | Primary image host API key |
| `CLOUDINARY_CLOUD_NAME` | No | Cloudinary cloud name for unsigned fallback uploads |
| `CLOUDINARY_UPLOAD_PRESET` | No | Cloudinary unsigned upload preset (paired with the cloud name) |
| `ADMIN_EMAIL` | No | Seeded admin email (default `admin@mentorlagbe.com`) |
| `ADMIN_PASSWORD` | No | Seeded admin password (default `Admin@12345`) |
| `ADMIN_NAME` | No | Seeded admin display name |
| `PORT` | No | Server port (default `5000`; Render injects `10000`) |
| `JWT_EXPIRES_IN` | No | Token lifetime (default `7d`) |
| `NODE_ENV` | No | `development` or `production` |

The database name is fixed as `LearnNest` in `config/db.js`.

## API routes

All `/api` responses are JSON with a `success` field. Protected routes need `Authorization: Bearer <token>`.

| Method | Route | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/` | Public | API name, version and route index |
| `GET` | `/health` | Public | Process uptime and database reachability |
| `POST` | `/api/auth/register` | Public | Create a student/instructor account, returns JWT |
| `POST` | `/api/auth/login` | Public | Email/password login, returns JWT |
| `GET` | `/api/auth/me` | Token | Current user profile |
| `PUT` | `/api/auth/me` | Token | Update name, phone, bio or image |
| `GET` | `/api/auth/google/status`, `/api/auth/google/start` | Public | Google auth stubs |
| `*` | `/api/better-auth/*` | Public | BetterAuth handler (or `503` if unconfigured) |
| `GET` | `/api/courses` | Public | Approved, active courses (search/category/level/mode/page/limit) |
| `GET` | `/api/courses/:id` | Public | One approved course |
| `POST` | `/api/courses` | Instructor | Submit a pending course (max 2 when on the free plan) |
| `GET` | `/api/courses/my-courses` | Instructor | Instructor's own courses |
| `PATCH` | `/api/courses/:id` | Instructor | Edit an owned course |
| `PATCH` | `/api/courses/:id/status` | Instructor | Activate/deactivate an owned course |
| `DELETE` | `/api/courses/:id` | Instructor | Delete an owned course |
| `GET` | `/api/courses/admin/pending` | Admin | Courses awaiting review |
| `PATCH` | `/api/courses/admin/review/:id` | Admin | Approve or reject a pending course |
| `POST` | `/api/enrollments` | Student | Apply to an approved course |
| `GET` | `/api/enrollments/my-enrollments` | Student | Student's applications |
| `GET` | `/api/enrollments/instructor-applicants` | Instructor | Applicants for owned courses |
| `PATCH` | `/api/enrollments/:id/status` | Instructor | Accept or reject a pending applicant |
| `DELETE` | `/api/enrollments/:id` | Student | Cancel a pending application |
| `PATCH` | `/api/enrollments/:id/restore` | Student | Restore a rejected application to pending |
| `POST` | `/api/payments/checkout` | Token | Create a monthly Pro Checkout Session; returns `url`, `sessionId` |
| `POST` | `/api/payments/verify` | Token | Verify `{ sessionId }` and activate the Pro plan |
| `POST` | `/api/payments/webhook` | Stripe signature | Raw-body webhook for completed/paid/canceled events |
| `POST` | `/api/upload/image` | Token | Multipart field `image` → `{ success, imageUrl, deleteUrl }` |
| `GET` | `/api/admin/stats` | Admin | Platform counters and revenue |
| `GET` | `/api/admin/users` | Admin | Paginated users (role/search filters) |
| `PATCH` | `/api/admin/users/:id/role` | Admin | Change a user's role |
| `GET` | `/api/admin/transactions` | Admin | Paginated payment history |

## Four-collection data design

Everything lives in the `LearnNest` database, in four collections. Related records are joined by email or stringified `ObjectId`, so the same shapes work in the API and the seed script.

| Collection | Key fields | Notes |
| --- | --- | --- |
| `users` | `name`, `email` (unique), `password`, `role` (`student`/`instructor`/`admin`), `plan` (`free`/`pro`), `phone`, `bio`, `image`, `stripeSubscriptionId` | Also stores BetterAuth records; the email index is sparse. Passwords are bcrypt hashes. |
| `courses` | `title`, `category`, `level`, `mode`, `duration`, `price`, `thumbnail`, `description`, `instructorEmail`, `instructorName`, `approvalStatus`, `isActive` | Only `approved` + `isActive: true` courses are public. No unique title constraint. |
| `enrollments` | `courseId` (string), `courseTitle`, `studentEmail`, `instructorEmail`, `status` (`pending`/`accepted`/`rejected`), `preferredSchedule`, `appliedAt` | Unique index on `courseId + studentEmail` enforces one application per course. |
| `payments` | `userEmail`, `planName`, `amount`, `currency`, `transactionId`, `stripeSessionId`, `stripeSubscriptionId`, `paymentStatus`, `paidAt` | Unique sparse index on `stripeSessionId`; Checkout sessions and renewal invoices both use it as the idempotency key. |

## Deployment notes

- Set **all** environment variables in your host (Render syncs from its dashboard; `render.yaml` marks secrets `sync: false`).
- Deploy the client first, then set `CLIENT_URL` to its real origin — Stripe success/cancel redirects and CORS depend on it.
- Register the webhook on the deployed API URL; local development can use the Stripe CLI (`stripe listen --forward-to localhost:5000/api/payments/webhook`).
- Configure at least one image provider (`IMGBB_API_KEY` **or** `CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_UPLOAD_PRESET`), otherwise uploads return `503`.
