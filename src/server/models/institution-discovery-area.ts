import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * `institution_discovery_areas`: places where MarutiX has donors or requests,
 * derived from the database and clustered into grid cells, so background
 * discovery can find and refresh hospitals and blood banks there. Only the
 * grid cell's own centre (cells are DISCOVERY_AREA_RADIUS_KM wide) and counts
 * are stored, never anyone's location or identity.
 */
const areaSchema = new Schema(
  {
    // "cell:<lat-index>:<lng-index>@<radius>" for areas with coordinates, "city:<name>" for places known only by city name.
    key: { type: String, required: true, maxlength: 80 },
    kind: { type: String, enum: ["cell", "city"], required: true },
    // Cell centre, or the geocoded city centre; absent until a city is geocoded.
    center: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number], default: undefined },
    },
    city: { type: String, maxlength: 60 },
    // False when no donor or request is in the area any more; kept, but not refreshed.
    active: { type: Boolean, required: true, default: true },
    radiusKm: { type: Number, required: true },
    label: { type: String, maxlength: 60 },
    donorPoints: { type: Number, required: true, default: 0 },
    requestPoints: { type: Number, required: true, default: 0 },
    derivedAt: { type: Date, required: true },
    // Due for discovery at or after this time (backoff pushes it later).
    nextRunAt: { type: Date, required: true },
    lastRunAt: { type: Date },
    lastSuccessAt: { type: Date },
    lastResult: {
      found: { type: Number },
      created: { type: Number },
      updated: { type: Number },
      merged: { type: Number },
      markedStale: { type: Number },
      truncated: { type: Boolean },
    },
    consecutiveFailures: { type: Number, required: true, default: 0 },
    lastError: { type: String, maxlength: 200 },
  },
  { collection: "institution_discovery_areas", timestamps: true, strict: "throw" },
);

areaSchema.index({ key: 1 }, { unique: true });
areaSchema.index({ active: 1, nextRunAt: 1 });

export type DiscoveryAreaDoc = InferSchemaType<typeof areaSchema>;

export const DiscoveryArea: Model<DiscoveryAreaDoc> =
  (models.DiscoveryArea as Model<DiscoveryAreaDoc>) ?? model<DiscoveryAreaDoc>("DiscoveryArea", areaSchema);
