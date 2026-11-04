import { randomBytes } from "node:crypto";

// Throwaway secrets for tests only. Integration tests use MONGODB_URI_TEST.
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST ?? "mongodb://127.0.0.1:1/unused";
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.AUTH_JWT_SECRET = randomBytes(32).toString("base64");
process.env.OTP_HASH_SECRET = randomBytes(32).toString("base64");
process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.OTP_PROVIDER = "development";
process.env.WHATSAPP_WEB_WORKER_SECRET = randomBytes(32).toString("base64");
process.env.WHATSAPP_WEB_TEST_RECIPIENTS = "+919000000001, 9000000002";
process.env.WHATSAPP_WEB_SESSION_DIR = ".data/test-whatsapp-session";
process.env.DISCOVERY_WEBSITE_ENRICHMENT = "false";
