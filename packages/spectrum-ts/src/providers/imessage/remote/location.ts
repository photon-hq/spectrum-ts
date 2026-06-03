import {
  type AdvancedIMessage,
  NotFoundError,
  type SharedFriendLocation,
} from "@photon-ai/advanced-imessage";
import { dmAddress, toChatGuid } from "./ids";

/**
 * A friend's shared Find My location, mapped from the advanced-imessage SDK's
 * `SharedFriendLocation`. Kept as a spectrum-owned type so the public API
 * stays decoupled from the SDK's shape — mirrors how `getAttachment` returns
 * a spectrum `Attachment` rather than the raw SDK record.
 */
export interface IMessageLocation {
  /** Horizontal accuracy in meters, when reported. */
  readonly accuracy?: number;
  /** The friend's address (phone number or email) this location belongs to. */
  readonly address: string;
  /** When this shared location stops being valid. */
  readonly expiresAt?: Date;
  /** True while the device is actively resolving a fresh fix. */
  readonly isLocatingInProgress: boolean;
  /** Latitude in decimal degrees. Absent while a fix is still resolving. */
  readonly latitude?: number;
  /** When the underlying location fix was taken. */
  readonly locationTimestamp?: Date;
  /** Quality/source of the fix. */
  readonly locationType: "legacy" | "live" | "shallow" | "unknown";
  /** Full human-readable address, when available. */
  readonly longAddress?: string;
  /** Longitude in decimal degrees. Absent while a fix is still resolving. */
  readonly longitude?: number;
  /** The friend's display name, when the device knows it. */
  readonly name?: string;
  /** Short human-readable address (e.g. a place name), when available. */
  readonly shortAddress?: string;
}

const mapLocation = (loc: SharedFriendLocation): IMessageLocation => ({
  address: loc.address,
  name: loc.name,
  latitude: loc.latitude,
  longitude: loc.longitude,
  accuracy: loc.accuracy,
  locationType: loc.locationType,
  locationTimestamp: loc.locationTimestamp,
  expiresAt: loc.expiresAt,
  isLocatingInProgress: loc.isLocatingInProgress,
  shortAddress: loc.shortAddress,
  longAddress: loc.longAddress,
});

/**
 * Fetch the friend's currently shared Find My location for a 1:1 chat. The
 * friend address is recovered from the DM chat guid (`space.id`), then passed
 * to the SDK's `locations.get`.
 *
 * Returns `undefined` when the friend isn't sharing a location with this
 * account (`sharedFriendLocationNotFound`, surfaced as `NotFoundError`) —
 * mirrors the not-found handling in `getRemoteAttachment`.
 */
export const getLocation = async (
  remote: AdvancedIMessage,
  spaceId: string
): Promise<IMessageLocation | undefined> => {
  const address = dmAddress(toChatGuid(spaceId));
  let raw: SharedFriendLocation;
  try {
    raw = await remote.locations.get(address);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return;
    }
    throw err;
  }
  return mapLocation(raw);
};
