import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import nodemailer from "nodemailer";

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
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
const transactions = db.collection("transactions");
const favorites = db.collection("favorites");
const reviews = db.collection("reviews");

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

  res.send(result);
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

  res.send(result);
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
    return res.status(400).send({ message: "Review Must Be 1000 Characters Or Less" });
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
app.get("/customer/favorites", verifyToken, verifyCustomer, async (req, res) => {
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
});

// একটি মেনু আইটেম গ্রাহকের পছন্দের তালিকায় যোগ করতে।
app.post("/customer/favorites", verifyToken, verifyCustomer, async (req, res) => {
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
});

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
  const pizzaData = {
    ...req.body,
    vendorId: req.user._id.toString(),
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
    return res.status(409).send({ message: "Order Status Has Already Changed" });
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

// admin-কে ব্যবহারকারীর প্রবেশাধিকার বন্ধ বা চালু করতে।
app.patch("/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  const { isBlocked } = req.body;

  if (typeof isBlocked !== "boolean") {
    return res.status(400).send({ message: "Invalid Block Status" });
  }

  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid User ID" });
  }

  const result = await users.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { isBlocked } },
  );

  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "User Not Found" });
  }

  res.send({ message: "User Status Updated Successfully" });
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
app.patch("/admin/menu-items/:id", verifyToken, verifyAdmin, async (req, res) => {
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
});

// admin-কে কোনো মেনু আইটেম মুছতে।
app.delete("/admin/menu-items/:id", verifyToken, verifyAdmin, async (req, res) => {
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
});

// admin-কে সব লেনদেনের তালিকা দেখাতে।
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
  const result = await transactions
    .find({})
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;
