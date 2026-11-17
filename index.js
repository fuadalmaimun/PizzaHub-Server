import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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


app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running!");
});

app.post("/menu-items", async (req, res) => {
  const pizzaData = req.body;
  const result = await menuItems.insertMany(pizzaData);
  res.send(result);
});

app.get("/menu-items", async (req, res) => {
  const result = await menuItems.find({}).toArray();
  res.send(result);
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;
