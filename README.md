# 🍕 PizzaHub Server

Backend API for **PizzaHub**, a pizza ordering platform built with Node.js, Express.js, and MongoDB.

## 🚀 Technologies Used

- Node.js
- Express.js
- MongoDB
- Stripe Payment Gateway
- JavaScript
- dotenv
- CORS

## ✨ Features

- RESTful API for pizza management
- User management
- Food ordering system
- Order management
- Stripe payment integration
- Yearly Premium Subscription ($10/year)
- Subscription renewal and cancellation handling
- Secure environment variable configuration

## 📦 Dependencies

- express
- mongodb
- cors
- dotenv
- stripe

## ⚙️ Installation & Setup

**1. Clone the repository**

```bash
git clone YOUR_BACKEND_REPOSITORY_URL
```

**2. Navigate to the project directory**

```bash
cd pizzahub-server
```

**3. Install dependencies**

```bash
npm install
```

**4. Create a `.env` file**



**5. Start the server**

```bash
npm start
```

For development:

```bash
npm run dev
```

## 🔗 API Base URL

```text
http://localhost:5000
```

## 💳 Payment System

PizzaHub uses Stripe for payment processing.

- Customers can pay for their food orders.
- Premium membership costs $10 per year.
- Premium membership uses recurring subscription billing.
- Subscription renewals and cancellations are handled through Stripe webhooks.

## 📁 Project Structure

```text
pizzahub-server/
├── index.js
├── .env
├── package.json
└── README.md
```

## 🔐 Environment Variables

Never share or commit your `.env` file. Keep all secret keys private.

## 👨‍💻 Author

**Fuad Al Maimun**

- GitHub: https://github.com/fuadalmaimun
- Portfolio: https://fuad-al-maimun.vercel.app

---

Made with ❤️ for PizzaHub.