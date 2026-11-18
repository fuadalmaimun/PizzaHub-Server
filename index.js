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
    from: process.env.EMAIL_USER,
    to: to,
    subject: subject,
    text: message,
  });
};

// Verify Token
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

// Home
app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running!");
});

// Get All Approved Menu Items
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

// Get Single Menu Item
app.get("/menu-items/:id", async (req, res) => {
  const result = await menuItems.findOne({
    _id: new ObjectId(req.params.id),
    status: "approved",
    isAvailable: { $ne: false },
    isActive: { $ne: false },
  });

  res.send(result);
});

// Add Menu Item
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

// Get Vendor Menu Items
app.get("/vendor/menu-items", verifyToken, verifyVendor, async (req, res) => {
  const result = await menuItems
    .find({
      vendorId: req.user._id.toString(),
    })
    .toArray();

  res.send(result);
});

// Update Menu Item
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

// Delete Menu Item
app.delete("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  const result = await menuItems.deleteOne({
    _id: new ObjectId(req.params.id),
    vendorId: req.user._id.toString(),
  });

  res.send(result);
});

// Get Vendor Orders
app.get("/vendor/orders", verifyToken, verifyVendor, async (req, res) => {
  const result = await orders
    .find({
      vendorId: req.user._id.toString(),
    })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});

// Vendor Accept / Reject Order
app.patch("/vendor/orders/:id", verifyToken, verifyVendor, async (req, res) => {
  const { status } = req.body;

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).send({ message: "Invalid Status" });
  }

  const result = await orders.updateOne(
    {
      _id: new ObjectId(req.params.id),
      vendorId: req.user._id.toString(),
      status: "pending",
    },
    { $set: { status } },
  );

  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "Order Not Found" });
  }

  res.send({ message: "Order Updated Successfully" });
});

// Vendor Dashboard Overview
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

// Customer Dashboard Overview
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

// Get Customer Orders
app.get("/customer/orders", verifyToken, verifyCustomer, async (req, res) => {
  const result = await orders
    .find({
      customerId: req.user._id.toString(),
    })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});

// Place Customer Order
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
    createdAt: new Date(),
  };

  const result = await orders.insertOne(order);

  await sendEmail(
    vendor.email,
    "New Pizza Order",
    `You received a new order for ${order.itemName}`,
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

// Customer Cancel API
app.patch("/customer/orders/:id", verifyToken, verifyCustomer, cancelOrder);
app.delete("/customer/orders/:id", verifyToken, verifyCustomer, cancelOrder);

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;
