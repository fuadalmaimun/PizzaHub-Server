import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import nodemailer from "nodemailer";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 5000;

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());

// Stripe needs the raw request body to verify the signature.
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    // 1) Verify that the request really came from Stripe.
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      console.error(
        "Stripe webhook signature verification failed:",
        error.message,
      );
      return res.status(400).send({ message: "Invalid Stripe signature" });
    }

    try {
      // 1) First payment: the vendor finished Stripe Checkout and the
      //    yearly subscription started.
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.mode === "subscription" && isPaidCheckout(session)) {
          await activatePremium(session);
        }
      }

      // 2) Renewal: Stripe charged the saved card again after one year.
      if (event.type === "invoice.paid") {
        const invoice = event.data.object;

        if (
          invoice.billing_reason === "subscription_cycle" &&
          invoice.status === "paid"
        ) {
          await handleInvoiceRenewal(invoice);
        }
      }

      // 3) Plan updated (for example "cancel at period end" was turned on).
      if (event.type === "customer.subscription.updated") {
        await syncSubscription(event.data.object);
      }

      // 4) Subscription cancelled/ended: back to the Free plan.
      if (event.type === "customer.subscription.deleted") {
        await endSubscription(event.data.object);
      }

      // Stripe expects a 200 so it does not retry the event.
      res.send({ received: true });
    } catch (error) {
      console.error("Stripe webhook handling failed:", error);
      // Non-2xx makes Stripe retry later, which is what we want on a real failure.
      res.status(500).send({ message: "Webhook handling failed" });
    }
  },
);

app.use(express.json());

// MongoDB Connection
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();

console.log("MongoDB Connected!");

const db = client.db(process.env.DB_NAME);
const menuItems = db.collection("menuItems");
const users = db.collection("user");
const sessions = db.collection("session");
const orders = db.collection("orders");
const favorites = db.collection("favorites");
const reviews = db.collection("reviews");
const transactions = db.collection("transactions");

// ---------------------------------------------------------------------------
// Vendor plan limits
// Free vendors can keep at most 3 active items. Premium is unlimited.
// "Active" means the same thing the vendor dashboard shows: the item is not
// inactive, not switched off and not marked unavailable.
// ---------------------------------------------------------------------------


const FREE_ACTIVE_ITEM_LIMIT = 3;

function isPremiumVendor(user) {
  return user?.subscriptionPlan === "premium";
}

function isActiveItem(item) {
  return (
    item.status !== "inactive" &&
    item.isAvailable !== false &&
    item.isActive !== false
  );
}

async function countActiveItems(vendorId) {
  return menuItems.countDocuments({
    vendorId,
    status: { $ne: "inactive" },
    isAvailable: { $ne: false },
    isActive: { $ne: false },
  });
}

// Same answer for create and for activating an older item.
function freePlanLimitMessage() {
  return `Your Free plan allows ${FREE_ACTIVE_ITEM_LIMIT} active menu items. Upgrade to Premium for unlimited items.`;
}

// Public menu items are shown together with their vendor so the site can show
// the Premium badge and put Premium vendors first.
async function attachVendors(items) {
  const vendorIds = [
    ...new Set(items.map((item) => item.vendorId).filter(Boolean)),
  ];
  if (vendorIds.length === 0) return items;

  const vendorObjectIds = vendorIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const vendorDocs = await users
    .find({ _id: { $in: vendorObjectIds } })
    .project({
      name: 1,
      businessName: 1,
      subscriptionPlan: 1,
      image: 1,
      location: 1,
    })
    .toArray();

  const vendorById = new Map(
    vendorDocs.map((vendor) => [vendor._id.toString(), vendor]),
  );

  return items.map((item) => ({
    ...item,
    vendor: vendorById.get(String(item.vendorId)) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Premium subscription helpers
// Premium is a $10/year Stripe subscription. These helpers are shared by the
// webhook and by the success page's verify endpoint.
// ---------------------------------------------------------------------------

const PREMIUM_YEARLY_PRICE = 10; // dollars

// Stripe stores the end of the paid period on the subscription item.
function getPeriodEnd(subscription) {
  const seconds =
    subscription?.items?.data?.[0]?.current_period_end ??
    subscription?.current_period_end;

  return seconds ? new Date(seconds * 1000) : null;
}

// A subscription checkout is finished once Stripe has the first payment.
function isPaidCheckout(session) {
  return (
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required"
  );
}

// Finds which vendor a Stripe subscription belongs to.
async function findVendorId(subscription, checkoutVendorId) {
  const candidates = [checkoutVendorId, subscription?.metadata?.vendorId];

  for (const id of candidates) {
    if (id && ObjectId.isValid(id)) {
      return new ObjectId(id);
    }
  }

  // Fallback for renewals whose metadata is missing.
  const vendor = await users.findOne({
    stripeSubscriptionId: subscription?.id,
  });
  return vendor?._id ?? null;
}

// Saves a payment only once. Renewals are matched by invoice id, the first
// payment by checkout session id.
async function saveTransaction(transaction) {
  const filter = transaction.stripeInvoiceId
    ? { stripeInvoiceId: transaction.stripeInvoiceId }
    : { stripeSessionId: transaction.stripeSessionId };

  const existing = await transactions.findOne(filter);
  if (existing) return existing;

  const document = { ...transaction, createdAt: new Date() };
  const result = await transactions.insertOne(document);

  return { _id: result.insertedId, ...document };
}

// Unlocks Premium and stores the Stripe subscription details on the vendor.
async function setPremium(vendorId, subscription) {
  const customerId =
    typeof subscription?.customer === "string"
      ? subscription.customer
      : subscription?.customer?.id;

  await users.updateOne(
    { _id: vendorId },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionStatus: subscription?.status ?? "active",
        subscriptionExpiresAt: getPeriodEnd(subscription),
        cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
        stripeCustomerId: customerId ?? null,
        stripeSubscriptionId: subscription?.id ?? null,
      },
    },
  );
}

// Downgrades the vendor (subscription cancelled or expired).
async function setFree(vendorId, status) {
  await users.updateOne(
    { _id: vendorId },
    {
      $set: {
        subscriptionPlan: "free",
        subscriptionStatus: status,
        cancelAtPeriodEnd: false,
      },
    },
  );
}

// First payment: the vendor just finished Stripe Checkout.
// Called by the webhook AND by the success page, so it saves only once.
async function activatePremium(session) {
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!subscriptionId) return null;

  const alreadySaved = await transactions.findOne({
    stripeSessionId: session.id,
  });
  if (alreadySaved) return alreadySaved;

  // Use the expanded subscription when Stripe already sent it.
  const subscription =
    typeof session.subscription === "object" && session.subscription
      ? session.subscription
      : await stripe.subscriptions.retrieve(subscriptionId);

  const vendorId = await findVendorId(subscription, session.metadata?.vendorId);
  if (!vendorId) return null;

  await setPremium(vendorId, subscription);

  return saveTransaction({
    vendorId,
    plan: "premium",
    kind: "subscription",
    amount: (session.amount_total ?? PREMIUM_YEARLY_PRICE * 100) / 100,
    currency: session.currency ?? "usd",
    status: "paid",
    stripeSessionId: session.id,
    stripeSubscriptionId: subscription.id,
    periodEnd: getPeriodEnd(subscription),
  });
}

// Renewal: Stripe charged the saved card again after one year.
async function handleInvoiceRenewal(invoice) {
  const subscriptionRef =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription;

  if (!subscriptionRef) return null;

  const subscription =
    typeof subscriptionRef === "object"
      ? subscriptionRef
      : await stripe.subscriptions.retrieve(subscriptionRef);

  const vendorId = await findVendorId(subscription);
  if (!vendorId) return null;

  // New period end = the next renewal date.
  await setPremium(vendorId, subscription);

  return saveTransaction({
    vendorId,
    plan: "premium",
    kind: "renewal",
    amount: (invoice.amount_paid ?? 0) / 100,
    currency: invoice.currency ?? "usd",
    status: invoice.status ?? "paid",
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscription.id,
    periodEnd: getPeriodEnd(subscription),
  });
}

// Subscription updated: keep plan and dates in sync.
async function syncSubscription(subscription) {
  const vendorId = await findVendorId(subscription);
  if (!vendorId) return;

  if (subscription.status === "active" || subscription.status === "trialing") {
    await setPremium(vendorId, subscription);
  } else {
    await setFree(vendorId, subscription.status ?? "canceled");
  }
}

// Subscription deleted/cancelled: Premium ends.
async function endSubscription(subscription) {
  const vendorId = await findVendorId(subscription);
  if (!vendorId) return;

  await setFree(vendorId, "canceled");
}

await Promise.all([
  favorites.createIndex({ customerId: 1, itemId: 1 }, { unique: true }),
  reviews.createIndex(
    { targetType: 1, targetId: 1, customerId: 1 },
    { unique: true },
  ),
]);

// Email transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});
// Send Email
const sendEmail = async (to, subject, message) => {
  await transporter.sendMail({
    from: {
      name: "Pizza Hub",
      address: process.env.EMAIL_USER,
    },
    to,
    subject,
    html: message,
  });
};

// লগইন করা ব্যবহারকারীর token যাচাই করে।
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  const sessionData = await sessions.findOne({ token });

  if (!sessionData) {
    return res.status(401).send({ message: "Invalid Token" });
  }

  const user = await users.findOne({ _id: sessionData.userId });

  if (!user || user.isBlocked) {
    return res.status(403).send({ message: "Access Denied" });
  }

  // A yearly subscription that was not renewed goes back to Free.
  if (
    user.subscriptionPlan === "premium" &&
    user.subscriptionExpiresAt &&
    new Date(user.subscriptionExpiresAt).getTime() < Date.now()
  ) {
    await users.updateOne(
      { _id: user._id },
      { $set: { subscriptionPlan: "free", subscriptionStatus: "expired" } },
    );

    user.subscriptionPlan = "free";
    user.subscriptionStatus = "expired";
  }

  req.user = user;
  next();
};

// Verify Vendor
const verifyVendor = (req, res, next) => {
  if (req.user.role !== "vendor") {
    return res.status(403).send({ message: "Vendor Only" });
  }
  next();
};

// Verify Customer
const verifyCustomer = (req, res, next) => {
  if (req.user.role !== "customer") {
    return res.status(403).send({ message: "Customer Only" });
  }
  next();
};

// Verify Admin
const verifyAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).send({ message: "Access Denied" });
  }

  next();
};

// Create Premium Subscription Session ($10 per year)
app.post(
  "/vendor/create-checkout-session",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    const priceId = process.env.STRIPE_YEARLY_PRICE_ID;

    if (!priceId) {
      return res
        .status(500)
        .send({ message: "The yearly Premium price is not configured." });
    }

    if (req.user.subscriptionPlan === "premium") {
      return res.status(400).send({ message: "You already have Premium." });
    }

    try {
      const vendorId = req.user._id.toString();

      const session = await stripe.checkout.sessions.create({
        // Recurring payment: Stripe charges the vendor $10 every year.
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { vendorId },
        // Renewal invoices carry the vendor id too, so webhooks can find the vendor.
        subscription_data: { metadata: { vendorId } },
        // Pre-fills the email input on Stripe Checkout with the vendor's email.
        customer_email: req.user.email,
        success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
      });

      res.send({ url: session.url });
    } catch (error) {
      console.error("Stripe checkout session failed:", error);
      res
        .status(500)
        .send({ message: "Could not start the payment. Please try again." });
    }
  },
);

// Vendor's own subscription plan (used by the Subscription page + payment success page).
// Premium itself is only set after Stripe confirms the subscription payment.
app.get("/vendor/subscription", verifyToken, verifyVendor, async (req, res) => {
  res.send({
    subscriptionPlan:
      req.user.subscriptionPlan === "premium" ? "premium" : "free",
    subscriptionStatus: req.user.subscriptionStatus ?? null,
    subscriptionExpiresAt: req.user.subscriptionExpiresAt ?? null,
    cancelAtPeriodEnd: Boolean(req.user.cancelAtPeriodEnd),
  });
});

// Cancel (or resume) the yearly renewal. Access stays until the paid period ends.
app.post(
  "/vendor/cancel-subscription",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    if (!req.user.stripeSubscriptionId) {
      return res
        .status(400)
        .send({ message: "You do not have a Premium subscription." });
    }

    // Default action is "cancel at period end"; send { cancel: false } to resume.
    const cancel = req.body?.cancel !== false;

    try {
      const subscription = await stripe.subscriptions.update(
        req.user.stripeSubscriptionId,
        { cancel_at_period_end: cancel },
      );

      await syncSubscription(subscription);

      res.send({
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        subscriptionExpiresAt: getPeriodEnd(subscription),
      });
    } catch (error) {
      console.error("Subscription cancellation failed:", error);
      res.status(500).send({
        message: "Could not update your subscription. Please try again.",
      });
    }
  },
);

// Success page calls this so a delayed/missing webhook never hides a real payment.
// The session is verified directly with Stripe using the secret key (server only).
app.post(
  "/vendor/verify-payment",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    const sessionId = req.body?.sessionId;

    if (!sessionId || typeof sessionId !== "string") {
      return res
        .status(400)
        .send({ message: "A checkout session id is required." });
    }

    try {
      // Expand the subscription so we can read the renewal date.
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription"],
      });

      if (session.metadata?.vendorId !== req.user._id.toString()) {
        return res
          .status(403)
          .send({ message: "This payment does not belong to you." });
      }

      if (!isPaidCheckout(session)) {
        return res
          .status(400)
          .send({ message: "Payment is not completed yet." });
      }

      if (session.mode !== "subscription" || !session.subscription) {
        return res
          .status(400)
          .send({ message: "This checkout is not a Premium subscription." });
      }

      await activatePremium(session);
      res.send({ verified: true });
    } catch (error) {
      console.error("Payment verification failed:", error);
      res.status(500).send({ message: "Could not verify the payment." });
    }
  },
);

// Vendor payment history (newest first).
app.get("/vendor/transactions", verifyToken, verifyVendor, async (req, res) => {
  const result = await transactions
    .find({ vendorId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  res.send(result);
});

// One transaction by Stripe checkout session id (must belong to this vendor).
app.get(
  "/vendor/transactions/:sessionId",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    const transaction = await transactions.findOne({
      stripeSessionId: req.params.sessionId,
      vendorId: req.user._id,
    });

    if (!transaction) {
      return res.status(404).send({ message: "Payment is not saved yet." });
    }

    res.send(transaction);
  },
);

// সার্ভার চালু আছে কি না পরীক্ষা করতে।
app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running!");
});

// গ্রাহকদের জন্য অনুমোদিত মেনু আইটেম দেখাতে।
app.get("/menu-items", async (req, res) => {
  const result = await menuItems
    .find({
      status: "approved",
      isAvailable: { $ne: false },
      isActive: { $ne: false },
    })
    .toArray();

  res.send(await attachVendors(result));
});

// নির্দিষ্ট একটি অনুমোদিত মেনু আইটেমের বিস্তারিত দেখাতে।
app.get("/menu-items/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid Menu Item ID" });
  }

  const result = await menuItems.findOne({
    _id: new ObjectId(req.params.id),
    status: "approved",
    isAvailable: { $ne: false },
    isActive: { $ne: false },
  });

  if (!result) return res.send(result);

  const [itemWithVendor] = await attachVendors([result]);
  res.send(itemWithVendor);
});

async function findReviewTarget(targetType, targetId) {
  if (!ObjectId.isValid(targetId)) return null;

  const objectId = new ObjectId(targetId);
  if (targetType === "menuItem") {
    const target = await menuItems.findOne({
      _id: objectId,
      status: "approved",
      isAvailable: { $ne: false },
      isActive: { $ne: false },
    });
    return target ? { target, collection: menuItems, objectId } : null;
  }

  if (targetType === "restaurant") {
    const target = await users.findOne({ _id: objectId, role: "vendor" });
    return target ? { target, collection: users, objectId } : null;
  }

  return null;
}

async function getReviewSummary(targetType, targetId) {
  const [summary] = await reviews
    .aggregate([
      { $match: { targetType, targetId } },
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          reviewCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  return {
    averageRating: Number((summary?.averageRating ?? 0).toFixed(1)),
    reviewCount: summary?.reviewCount ?? 0,
  };
}

// কোনো মেনু আইটেম বা রেস্টুরেন্টের রিভিউ ও গড় rating দেখাতে।
app.get("/reviews", async (req, res) => {
  const { targetType, targetId } = req.query;
  if (
    typeof targetType !== "string" ||
    typeof targetId !== "string" ||
    !["menuItem", "restaurant"].includes(targetType)
  ) {
    return res.status(400).send({ message: "Invalid Review Target" });
  }

  const target = await findReviewTarget(targetType, targetId);
  if (!target) {
    return res.status(404).send({ message: "Review Target Not Found" });
  }

  const filter = { targetType, targetId };
  const [reviewList, summary] = await Promise.all([
    reviews.find(filter).sort({ createdAt: -1 }).toArray(),
    getReviewSummary(targetType, targetId),
  ]);

  res.send({
    reviews: reviewList,
    ...summary,
  });
});

// গ্রাহকের রিভিউ যোগ বা আপডেট করতে।
app.post("/reviews", verifyToken, verifyCustomer, async (req, res) => {
  const { targetType, targetId, rating, comment = "" } = req.body ?? {};
  if (
    typeof targetType !== "string" ||
    !["menuItem", "restaurant"].includes(targetType) ||
    typeof targetId !== "string" ||
    !ObjectId.isValid(targetId)
  ) {
    return res.status(400).send({ message: "Invalid Review Target" });
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).send({ message: "Rating Must Be Between 1 and 5" });
  }

  if (typeof comment !== "string" || comment.trim().length > 1000) {
    return res
      .status(400)
      .send({ message: "Review Must Be 1000 Characters Or Less" });
  }

  const target = await findReviewTarget(targetType, targetId);
  if (!target) {
    return res.status(404).send({ message: "Review Target Not Found" });
  }

  const customerId = req.user._id.toString();
  const now = new Date();
  const reviewFilter = { targetType, targetId, customerId };
  await reviews.updateOne(
    reviewFilter,
    {
      $set: {
        rating,
        comment: comment.trim(),
        customerName: req.user.name,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  const { averageRating, reviewCount } = await getReviewSummary(
    targetType,
    targetId,
  );

  await target.collection.updateOne(
    { _id: target.objectId },
    { $set: { rating: averageRating, reviewCount } },
  );

  const review = await reviews.findOne(reviewFilter);
  res.send({ review, averageRating, reviewCount });
});

// গ্রাহকের পছন্দের চালু মেনু আইটেমগুলো দেখাতে।
app.get(
  "/customer/favorites",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    const savedFavorites = await favorites
      .find({ customerId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();
    const itemIds = savedFavorites
      .map((favorite) => favorite.itemId)
      .filter((itemId) => ObjectId.isValid(itemId))
      .map((itemId) => new ObjectId(itemId));

    if (itemIds.length === 0) return res.send([]);

    const availableItems = await menuItems
      .find({
        _id: { $in: itemIds },
        status: "approved",
        isAvailable: { $ne: false },
        isActive: { $ne: false },
      })
      .toArray();
    const itemsById = new Map(
      availableItems.map((item) => [item._id.toString(), item]),
    );
    res.send(
      savedFavorites
        .map((favorite) => itemsById.get(favorite.itemId))
        .filter(Boolean),
    );
  },
);

// একটি মেনু আইটেম গ্রাহকের পছন্দের তালিকায় যোগ করতে।
app.post(
  "/customer/favorites",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    const { itemId } = req.body ?? {};
    if (typeof itemId !== "string" || !ObjectId.isValid(itemId)) {
      return res.status(400).send({ message: "Invalid Menu Item ID" });
    }

    const menuItem = await menuItems.findOne({
      _id: new ObjectId(itemId),
      status: "approved",
      isAvailable: { $ne: false },
      isActive: { $ne: false },
    });
    if (!menuItem) {
      return res.status(404).send({ message: "Menu Item Not Found" });
    }

    await favorites.updateOne(
      { customerId: req.user._id.toString(), itemId },
      {
        $setOnInsert: {
          customerId: req.user._id.toString(),
          itemId,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.send({ message: "Menu Item Added To Favorites" });
  },
);

// পছন্দের তালিকা থেকে একটি মেনু আইটেম সরাতে।
app.delete(
  "/customer/favorites/:itemId",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.itemId)) {
      return res.status(400).send({ message: "Invalid Menu Item ID" });
    }

    await favorites.deleteOne({
      customerId: req.user._id.toString(),
      itemId: req.params.itemId,
    });
    res.send({ message: "Menu Item Removed From Favorites" });
  },
);

// বিক্রেতার নতুন মেনু আইটেম অনুমোদনের জন্য জমা দিতে।
app.post("/menu-items", verifyToken, verifyVendor, async (req, res) => {
  const vendorId = req.user._id.toString();

  // Free vendors stop at 3 active items.
  if (!isPremiumVendor(req.user)) {
    const activeCount = await countActiveItems(vendorId);
    if (activeCount >= FREE_ACTIVE_ITEM_LIMIT) {
      return res.status(403).send({
        code: "FREE_PLAN_LIMIT",
        message: freePlanLimitMessage(),
      });
    }
  }

  const pizzaData = {
    ...req.body,
    vendorId,
    status: "pending",
    createdAt: new Date(),
  };

  const result = await menuItems.insertOne(pizzaData);
  res.send(result);
});

// বিক্রেতার নিজের সব মেনু আইটেম দেখাতে।
app.get("/vendor/menu-items", verifyToken, verifyVendor, async (req, res) => {
  const result = await menuItems
    .find({
      vendorId: req.user._id.toString(),
    })
    .toArray();

  res.send(result);
});

// বিক্রেতার নিজের মেনু আইটেম সম্পাদনা করতে।
app.patch("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  const { vendorId, status, ...data } = req.body;

  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid Menu Item ID" });
  }

  const existing = await menuItems.findOne({
    _id: new ObjectId(req.params.id),
    vendorId: req.user._id.toString(),
  });

  if (!existing) {
    return res.status(404).send({ message: "Menu Item Not Found" });
  }

  // Activating an item counts against the Free plan limit too.
  const willBeActive = isActiveItem({ ...existing, ...data });
  if (!isPremiumVendor(req.user) && willBeActive && !isActiveItem(existing)) {
    const activeCount = await countActiveItems(req.user._id.toString());
    if (activeCount >= FREE_ACTIVE_ITEM_LIMIT) {
      return res.status(403).send({
        code: "FREE_PLAN_LIMIT",
        message: freePlanLimitMessage(),
      });
    }
  }

  const result = await menuItems.updateOne(
    {
      _id: new ObjectId(req.params.id),
      vendorId: req.user._id.toString(),
    },
    { $set: data },
  );

  res.send(result);
});

// বিক্রেতার নিজের মেনু আইটেম মুছতে।
app.delete("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  const result = await menuItems.deleteOne({
    _id: new ObjectId(req.params.id),
    vendorId: req.user._id.toString(),
  });

  res.send(result);
});

// বিক্রেতার পাওয়া অর্ডারগুলো দেখাতে।
app.get("/vendor/orders", verifyToken, verifyVendor, async (req, res) => {
  const result = await orders
    .find({
      vendorId: req.user._id.toString(),
    })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});

// বিক্রেতাকে অর্ডার গ্রহণ বা বাতিল করতে।
app.patch("/vendor/orders/:id", verifyToken, verifyVendor, async (req, res) => {
  const { status } = req.body;

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).send({ message: "Invalid Status" });
  }

  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid Order ID" });
  }

  const order = await orders.findOne({
    _id: new ObjectId(req.params.id),
    vendorId: req.user._id.toString(),
    status: "pending",
  });

  if (!order) {
    return res.status(404).send({ message: "Order Not Found" });
  }

  const changedAt = new Date();
  const result = await orders.updateOne(
    { _id: order._id, vendorId: req.user._id.toString(), status: "pending" },
    {
      $set: { status, updatedAt: changedAt },
      $push: {
        statusHistory: {
          status,
          changedAt,
          actorRole: "vendor",
        },
      },
    },
  );
  if (result.modifiedCount === 0) {
    return res
      .status(409)
      .send({ message: "Order Status Has Already Changed" });
  }

  const customer = await users.findOne({
    _id: new ObjectId(order.customerId),
  });

  // Send Email to Customer
  await sendEmail(
    customer.email,
    `Your Order ${status}`,
    `
      <h2>PizzaHub Order Update</h2>
      <img src="${order.itemImage}" width="250" />
      <h3>${order.itemName}</h3>
      <p>Price: ৳${order.itemPrice}</p>
      <p>Status: ${status}</p>
      <p>Your order has been ${status} by the vendor.</p>
    `,
  );

  res.send({ message: "Order Updated Successfully" });
});

// বিক্রেতার dashboard-এর সংক্ষিপ্ত হিসাব দেখাতে।
app.get("/vendor/overview", verifyToken, verifyVendor, async (req, res) => {
  const vendorId = req.user._id.toString();

  const totalMenuItems = await menuItems.countDocuments({ vendorId });
  const activeMenuItems = await menuItems.countDocuments({
    vendorId,
    status: "approved",
  });
  const pendingOrders = await orders.countDocuments({
    vendorId,
    status: "pending",
  });
  const acceptedOrders = await orders.countDocuments({
    vendorId,
    status: "accepted",
  });

  res.send({
    totalMenuItems,
    activeMenuItems,
    pendingOrders,
    acceptedOrders,
  });
});

// গ্রাহকের dashboard-এর অর্ডার হিসাব দেখাতে।
app.get("/customer/overview", verifyToken, verifyCustomer, async (req, res) => {
  const customerId = req.user._id.toString();

  const totalOrders = await orders.countDocuments({ customerId });
  const pendingOrders = await orders.countDocuments({
    customerId,
    status: "pending",
  });
  const acceptedOrders = await orders.countDocuments({
    customerId,
    status: "accepted",
  });
  const rejectedOrders = await orders.countDocuments({
    customerId,
    status: "rejected",
  });

  res.send({
    totalOrders,
    pendingOrders,
    acceptedOrders,
    rejectedOrders,
  });
});

// গ্রাহকের নিজের সব অর্ডার দেখাতে।
app.get("/customer/orders", verifyToken, verifyCustomer, async (req, res) => {
  const result = await orders
    .find({
      customerId: req.user._id.toString(),
    })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});

// গ্রাহককে একটি মেনু আইটেম অর্ডার করতে।
app.post("/orders", verifyToken, verifyCustomer, async (req, res) => {
  const { itemId, deliveryDate, deliveryAddress, message } = req.body;

  if (!ObjectId.isValid(itemId)) {
    return res.status(400).send({ message: "Invalid Menu Item" });
  }

  if (!deliveryDate || !deliveryAddress?.trim()) {
    return res.status(400).send({ message: "Date and Address Required" });
  }

  const menuItem = await menuItems.findOne({
    _id: new ObjectId(itemId),
    status: "approved",
    isAvailable: { $ne: false },
    isActive: { $ne: false },
  });

  if (!menuItem) {
    return res.status(404).send({ message: "Menu Item Not Found" });
  }

  const vendorId = menuItem.vendorId.toString();

  if (vendorId === req.user._id.toString()) {
    return res.status(403).send({ message: "Cannot Order Your Own Item" });
  }

  const vendor = await users.findOne({
    _id: new ObjectId(vendorId),
  });

  if (!vendor) {
    return res.status(404).send({ message: "Vendor Not Found" });
  }

  // Save Order
  const createdAt = new Date();
  const order = {
    itemId: menuItem._id.toString(),
    vendorId,
    customerId: req.user._id.toString(),
    itemName: menuItem.itemName || menuItem.name,
    itemImage: menuItem.images?.[0] || menuItem.image || null,
    images: menuItem.images || [],
    itemPrice: menuItem.price,
    vendorName: vendor.businessName || vendor.name,
    deliveryDate,
    deliveryAddress: deliveryAddress.trim(),
    message: message || "",
    status: "pending",
    statusHistory: [
      {
        status: "pending",
        changedAt: createdAt,
        actorRole: "customer",
      },
    ],
    createdAt,
  };

  const result = await orders.insertOne(order);

  await sendEmail(
    vendor.email,
    "New Pizza Order - PizzaHub",
    `
    <h2>New Pizza Order!</h2>

    <img
      src="${order.itemImage}"
      alt="${order.itemName}"
      width="250"
      style="border-radius: 10px;"
    />

    <h3>${order.itemName}</h3>
    <p>Category: ${menuItem.category}</p>
    <p>Price: ৳${order.itemPrice}</p>
    <p>Customer: ${req.user.name}</p>
    <p>Delivery Date: ${order.deliveryDate}</p>
    <p>Address: ${order.deliveryAddress}</p>
    <p>Message: ${order.message || "No message"}</p>
    <p>Order ID: ${result.insertedId}</p>
  `,
  );

  res.status(201).send({
    ...order,
    _id: result.insertedId,
  });
});

// Cancel Customer Pending Order
const cancelOrder = async (req, res) => {
  const result = await orders.deleteOne({
    _id: new ObjectId(req.params.id),
    customerId: req.user._id.toString(),
    status: "pending",
  });

  if (result.deletedCount === 0) {
    return res.status(404).send({
      message: "Order Not Found or Cannot Be Cancelled",
    });
  }

  res.send({ message: "Order Cancelled Successfully" });
};

// গ্রাহকের অপেক্ষমাণ অর্ডার বাতিল করতে (PATCH পদ্ধতি)।
app.patch("/customer/orders/:id", verifyToken, verifyCustomer, cancelOrder);
// একই অর্ডার বাতিলের জন্য DELETE পদ্ধতিটিও সমর্থন করতে।
app.delete("/customer/orders/:id", verifyToken, verifyCustomer, cancelOrder);

// admin-কে সাইটের মোট ব্যবহারকারী, মেনু ও লেনদেন দেখাতে।
app.get("/admin/overview", verifyToken, verifyAdmin, async (req, res) => {
  const totalUsers = await users.countDocuments();
  const totalVendors = await users.countDocuments({ role: "vendor" });
  const totalCustomers = await users.countDocuments({ role: "customer" });
  const totalMenuItems = await menuItems.countDocuments();
  const pendingMenuItems = await menuItems.countDocuments({
    status: "pending",
  });
  const totalTransactions = await transactions.countDocuments();

  res.send({
    totalUsers,
    totalVendors,
    totalCustomers,
    totalMenuItems,
    pendingMenuItems,
    totalTransactions,
  });
});

// admin-কে ব্যবহারকারী খুঁজতে ও role অনুযায়ী তালিকা দেখাতে।
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  const search = req.query.search || "";
  const role = req.query.role || "";

  const filter = {};

  // Search by Name or Email
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  // Filter by Role
  if (role) {
    filter.role = role;
  }

  const result = await users
    .find(filter, {
      projection: {
        password: 0,
      },
    })
    .toArray();

  res.send(result);
});

// admin-কে ব্যবহারকারীর role বদলাতে বা প্রবেশাধিকার বন্ধ/চালু করতে।
const ASSIGNABLE_ROLES = ["admin", "vendor", "customer"];

app.patch("/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  const { isBlocked, role } = req.body ?? {};

  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid User ID" });
  }

  const update = {};

  if (isBlocked !== undefined) {
    if (typeof isBlocked !== "boolean") {
      return res.status(400).send({ message: "Invalid Block Status" });
    }
    update.isBlocked = isBlocked;
  }

  if (role !== undefined) {
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).send({ message: "Invalid Role" });
    }

    // An admin must not lock themselves out of the admin dashboard.
    if (req.params.id === req.user._id.toString() && role !== "admin") {
      return res
        .status(400)
        .send({ message: "You cannot change your own admin role." });
    }

    update.role = role;
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).send({ message: "Nothing To Update" });
  }

  const targetUser = await users.findOne({ _id: new ObjectId(req.params.id) });
  if (!targetUser) {
    return res.status(404).send({ message: "User Not Found" });
  }

  // A new vendor needs a storefront name and a subscription plan.
  if (update.role === "vendor") {
    if (!targetUser.businessName) update.businessName = targetUser.name;
    if (!targetUser.subscriptionPlan) update.subscriptionPlan = "free";
  }

  await users.updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });

  res.send({
    message: "User Updated Successfully",
    role: update.role ?? targetUser.role,
    isBlocked: update.isBlocked ?? Boolean(targetUser.isBlocked),
  });
});

// admin-কে মেনু আইটেম খুঁজতে ও status অনুযায়ী তালিকা দেখাতে।
app.get("/admin/menu-items", verifyToken, verifyAdmin, async (req, res) => {
  const search = req.query.search || "";
  const status = req.query.status || "";

  const filter = {};

  // Search by Item Name
  if (search) {
    filter.itemName = { $regex: search, $options: "i" };
  }

  // Filter by Status
  if (status) {
    filter.status = status;
  }

  const result = await menuItems.find(filter).toArray();

  res.send(result);
});

// admin-কে মেনু আইটেম অনুমোদন বা প্রত্যাখ্যান করতে।
app.patch(
  "/admin/menu-items/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { status } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).send({ message: "Invalid Status" });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid Menu Item ID" });
    }

    const result = await menuItems.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Menu Item Not Found" });
    }

    res.send({ message: "Menu Item Status Updated Successfully" });
  },
);

// admin-কে কোনো মেনু আইটেম মুছতে।
app.delete(
  "/admin/menu-items/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid Menu Item ID" });
    }

    const result = await menuItems.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Menu Item Not Found" });
    }

    res.send({ message: "Menu Item Deleted Successfully" });
  },
);

// admin-কে সব লেনদেনের তালিকা vendor তথ্য সহ দেখাতে।
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
  const result = await transactions
    .aggregate([
      { $sort: { createdAt: -1 } },
      // Each transaction stores the vendor id, so join the vendor document.
      {
        $lookup: {
          from: "user",
          localField: "vendorId",
          foreignField: "_id",
          as: "vendor",
        },
      },
      {
        $unwind: {
          path: "$vendor",
          preserveNullAndEmptyArrays: true,
        },
      },
      // Never send password / private auth fields to the browser.
      {
        $project: {
          "vendor.password": 0,
          "vendor.accounts": 0,
          "vendor.sessions": 0,
        },
      },
    ])
    .toArray();

  res.send(result);
});

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;
