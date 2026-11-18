import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Verify Token
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).send({ message: "No Auth Header" });
  }
  const token = authHeader.split(" ")[1];
  const sessionData = await sessions.findOne({ token });

  if (!sessionData) {
    return res.status(401).send({ message: "Session Not Found" });
  }

  const user = await users.findOne({
    _id: sessionData.userId,
  });

  if (!user) {
    return res.status(401).send({ message: "User Not Found" });
  }

  req.user = user;
  next();
};

// Verify Vendor
const verifyVendor = (req, res, next) => {
  if (req.user.role !== "vendor") {
    return res.status(403).send({ message: "Forbidden" });
  }

  next();
};

// MongoDB Connection
const client = new MongoClient(process.env.MONGODB_URI);

async function connectDB() {
  try {
    await client.connect();
    console.log("MongoDB Connected Successfully!");
  } catch (error) {
    console.log("MongoDB Connection Failed:", error);
  }
}

await connectDB();
// Case-sensitive: must match the database used by Better Auth (client .env DB_NAME)
const db = client.db(process.env.DB_NAME);
const menuItems = db.collection("menuItems");
const users = db.collection("user");
const sessions = db.collection("session");
const orders = db.collection("orders");

app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running!");
});

app.get("/menu-items", async (req, res) => {
  const result = await menuItems.find({}).toArray();
  res.send(result);
});

app.get("/menu-items/:id", async (req, res) => {
  const { id } = req.params;
  const result = await menuItems.findOne({
    _id: new ObjectId(id),
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
  const vendorId = req.user._id.toString();

  const result = await menuItems.find({ vendorId }).toArray();

  res.send(result);
});

// Delete Vendor Menu Item
app.delete("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  const id = new ObjectId(req.params.id);
  const result = await menuItems.deleteOne({_id: id,vendorId: req.user._id.toString(),
  });
  res.send(result);
});

// Update Vendor Menu Item
app.patch("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  const id = new ObjectId(req.params.id);

  const result = await menuItems.updateOne(
    {_id: id,
      vendorId: req.user._id.toString(),
    },
    {
      $set: req.body,
    }
  );
  res.send(result);
});

// Get Vendor Orders
app.get("/vendor/orders", verifyToken, verifyVendor, async (req, res) => {
  const vendorId = req.user._id.toString();

  const result = await orders.find({ vendorId }).toArray();

  res.send(result);
});

// Update Order Status
app.patch("/vendor/orders/:id", verifyToken, verifyVendor, async (req, res) => {
  const id = new ObjectId(req.params.id);

  const result = await orders.updateOne(
    {
      _id: id,
      vendorId: req.user._id.toString(),
      status: "pending",
    },
    {
      $set: {
        status: req.body.status,
      },
    }
  );

  res.send(result);
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;
