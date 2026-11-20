
+# 🍕 PizzaHub — Server (Express.js + MongoDB)
+
+**PizzaHub Server** is the backend API for PizzaHub, a role-based pizza ordering and delivery platform. Customers place food orders, vendors manage menu items and incoming orders, and admins manage users, menu items and platform transactions. Vendor Premium subscriptions are sold through Stripe Checkout and activated only after a verified Stripe webhook event.
+
+- **Live Website:** https://pizzahub-client.vercel.app
+- **Live API:** https://pizzahub-server-gamma.vercel.app

+
+## 🚀 Key Features
+
+### 👤 Customer
+- Place food orders with a delivery date, delivery address and special instructions — **no online payment is required for food orders**.
+- One active order per customer, item and delivery date (duplicate orders are rejected with `409`).
+- Cancel pending orders; keep a wishlist of favorite items; leave reviews and ratings.
+
+### 🏪 Vendor
+- Create, update, delete and toggle availability of menu items (images uploaded through **ImgBB**).
+- Review incoming orders and accept or reject them (pending orders only, one-time action).
+- Free plan: **max 3 active menu items** (enforced on the server with `403 FREE_PLAN_LIMIT`). Premium: unlimited items, Premium badge and featured homepage placement.
+- Upgrade, cancel or resume the Premium subscription through **Stripe Checkout** ($10 / year).
+
+### 🛡️ Admin
+- Manage users: search, filter by role, block/unblock, and change a user's role.
+- Review menu items: approve, reject, change status, or delete inappropriate items.
+- Read-only transaction history — admins cannot edit payment records.
+
+### 💳 Stripe
+- Checkout Sessions for the yearly Premium subscription.
+- Webhook handler with signature verification (`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`).
+- Premium is activated only after a verified webhook event. The `/vendor/verify-payment` endpoint re-checks the payment directly with Stripe as a fallback for a delayed webhook — the frontend success page never activates Premium on its own.
+
+## 🛠️ Technology Stack
+
+- **Runtime:** Node.js (ES modules, `"type": "module"`)
+- **Framework:** Express.js 5
+- **Database:** MongoDB (official `mongodb` driver, native collections — no ODM)
+- **Auth:** Better Auth session tokens + JWT verification with `jose` (JWKS)
+- **Payments:** Stripe Checkout + webhooks
+- **Email:** Nodemailer (order notifications to vendors, order status updates to customers)
+- **Images:** ImgBB API (menu item images, uploaded from the client)
+
+### npm packages used
+
+| Package | Purpose |
+|---|---|
+| `express` | HTTP server and routing |
+| `mongodb` | MongoDB driver (users, sessions, menuItems, orders, transactions) |
+| `jose` | JWT verification against the Better Auth JWKS |
+| `stripe` | Checkout Sessions and webhook signature verification |
+| `nodemailer` | Order and order-status emails |
+| `cors` | Cross-origin requests from the Next.js client |
+| `dotenv` | Environment variables from `.env` |
+
+## 🗄️ Database design (MongoDB)
+
+Better Auth manages its own auth collections (`user`, `session`, `account`, `verification`). The four business collections are:
+
+| Collection | Fields |
+|---|---|
+| `users` (Better Auth) | `name`, `email`, `image`, `role` (vendor / customer / admin), `isBlocked`, `businessName` (vendor only), `subscriptionPlan` (free / premium), `subscriptionExpiresAt` |
+| `menuItems` | `vendorId` (ref: users), `itemName`, `category`, `description`, `price`, `location`, `images`, `status` (pending / approved / rejected / inactive), `createdAt` |
+| `orders` | `itemId` (ref: menuItems), `vendorId` (ref: users), `customerId` (ref: users), `deliveryDate`, `deliveryAddress`, `message`, `status` (pending / accepted / rejected / cancelled), `createdAt` |
+| `transactions` | `vendorId` (ref: users), `plan`, `amount`, `currency`, `stripeSessionId`, `stripeSubscriptionId`, `status`, `createdAt` |
+
+## ⚙️ Installation & Setup
+
+### 1. Clone the repositories
+
+```bash
+git clone https://github.com/fuadalmaimun/PizaaHub-Client.git
+git clone https://github.com/fuadalmaimun/PizzaHub-Server.git
+```
+
+### 2. Install dependencies
+
+```bash
+cd PizzaHub-Server
+npm install
+```
