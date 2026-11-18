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

// Verify Token
// Verify Token
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  console.log("Received Token:", token);

  if (!token) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  const sessionData = await sessions.findOne({ token });

  console.log("Session Data:", sessionData);

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

  const order = await orders.findOne({
    _id: new ObjectId(req.params.id),
    vendorId: req.user._id.toString(),
    status: "pending",
  });

  if (!order) {
    return res.status(404).send({ message: "Order Not Found" });
  }

  await orders.updateOne({ _id: order._id }, { $set: { status } });

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

// Customer Cancel API
app.patch("/customer/orders/:id", verifyToken, verifyCustomer, cancelOrder);
app.delete("/customer/orders/:id", verifyToken, verifyCustomer, cancelOrder);



// Admin Overview
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

// Admin Get All Users
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

// Admin Block / Unblock User
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

// Admin Get All Menu Items
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

// Admin Approve / Reject Menu Item
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

// Admin Delete Menu Item
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

// Admin Get All Transactions
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
