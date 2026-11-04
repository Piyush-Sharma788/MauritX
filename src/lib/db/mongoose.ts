import "server-only";
import mongoose from "mongoose";
import { getEnv } from "@/lib/env";

// Reuse one connection across hot reloads and warm serverless invocations.
const globalForMongoose = globalThis as unknown as { __marutixMongoose?: Promise<typeof mongoose> };

export function connectToDatabase(): Promise<typeof mongoose> {
  if (!globalForMongoose.__marutixMongoose) {
    // Unknown filter keys are dropped. Client input only ever reaches queries
    // as Zod-validated primitives, never as raw objects.
    mongoose.set("strictQuery", true);
    globalForMongoose.__marutixMongoose = mongoose
      .connect(getEnv().MONGODB_URI, {
        serverSelectionTimeoutMS: 5_000,
        maxPoolSize: 10,
      })
      .catch((error) => {
        globalForMongoose.__marutixMongoose = undefined;
        throw error;
      });
  }
  return globalForMongoose.__marutixMongoose;
}
