import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const secret = process.env.LOVABLE_SYNC_SHARED_SECRET;

const body = JSON.stringify({
    shop: "colours-uniforms.myshopify.com",
    shopifyCustomerId: "8449370783815"
});

const signature = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("hex");

console.log("BODY:");
console.log(body);
console.log("\nSIGNATURE:");
console.log(signature);