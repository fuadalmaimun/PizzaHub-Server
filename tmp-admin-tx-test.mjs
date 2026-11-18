// Temporary test: admin role signup + admin transactions list.
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const clientBase = "http://localhost:3000";
const apiBase = "http://localhost:5000";
const password = "Test1234";
const stamp = Date.now();

const adminEmail = `admin-tx-${stamp}@pizzahub.test`;
const vendorEmail = `vendor-tx-${stamp}@pizzahub.test`;

async function signup(name, email, role) {
  const res = await fetch(`${clientBase}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: clientBase },
    body: JSON.stringify({ name, email, password, role }),
  });
  return { status: res.status, body: await res.json() };
}

const admin = await signup("Admin Tx Tester", adminEmail, "admin");
const vendor = await signup("Vendor Tx Shop", vendorEmail, "vendor");

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
const db = mongo.db(process.env.DB_NAME);

const vendorId = new ObjectId(vendor.body.user.id);
await db.collection("user").updateOne(
  { _id: vendorId },
  { $set: { businessName: "Vendor Tx Pizza", subscriptionPlan: "premium" } },
);

const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
const inserted = await db.collection("transactions").insertOne({
  vendorId,
  plan: "premium",
  kind: "subscription",
  amount: 10,
  currency: "usd",
  status: "paid",
  stripeSessionId: "cs_test_admin_ui_demo",
  stripeSubscriptionId: "sub_test_admin_ui_demo",
  periodEnd,
  createdAt: new Date(),
});

const adminApi = await fetch(`${apiBase}/admin/transactions`, {
  headers: { Authorization: `Bearer ${admin.body.token}` },
});
const adminBody = await adminApi.json();
const vendorApi = await fetch(`${apiBase}/admin/transactions`, {
  headers: { Authorization: `Bearer ${vendor.body.token}` },
});

console.log(
  JSON.stringify(
    {
      adminSignupStatus: admin.status,
      adminRole: admin.body.user.role,
      vendorRole: vendor.body.user.role,
      transactionId: inserted.insertedId.toString(),
      adminStatus: adminApi.status,
      transactionCount: adminBody.length,
      vendorInfo: adminBody[0]?.vendor
        ? {
            name: adminBody[0].vendor.name,
            email: adminBody[0].vendor.email,
            businessName: adminBody[0].vendor.businessName,
            hasPassword: "password" in adminBody[0].vendor,
          }
        : null,
      amount: adminBody[0]?.amount,
      status: adminBody[0]?.status,
      plan: adminBody[0]?.plan,
      kind: adminBody[0]?.kind,
      createdAt: adminBody[0]?.createdAt,
      vendorAccessStatus: vendorApi.status,
      adminEmail,
      vendorEmail,
      password,
      vendorId: vendor.body.user.id,
    },
    null,
    2,
  ),
);

await mongo.close();
