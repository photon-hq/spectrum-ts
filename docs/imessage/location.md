# iMessage — shared location (`space.location()`)

iMessage can share a contact's **Find My** location. Spectrum surfaces this as a
pair of iMessage-only space actions:

| Action | Direction | What it does |
| --- | --- | --- |
| `space.requestLocation()` | **send** | Drops a "share your location" Find My request card into the chat (fire-and-forget). |
| `space.location()` | **read** | Fetches the friend's *currently shared* location and returns it. |

This page covers the **read** side. `location()` is a data-returning action: it
calls the underlying `@photon-ai/advanced-imessage` `locations.get` and resolves
the friend's latest known position, or `undefined` if they aren't sharing.

> Both actions are **iMessage-only** and **1:1-only**, and require **remote**
> iMessage (a real `@photon-ai/advanced-imessage` client). They are not part of
> the universal `Content`/`Space` surface — reach them through the iMessage
> projection (`imessage(space)`), which is where TypeScript knows they exist.

---

## Usage

```typescript
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config({ /* … */ })],
});

for await (const [space, message] of app.messages) {
  // `imessage(space)` projects the generic Space to the iMessage space,
  // exposing iMessage-only methods like `.location()`.
  const loc = await imessage(space).location();

  if (loc?.latitude != null && loc.longitude != null) {
    await message.reply(
      `📍 ${loc.name ?? loc.address} is near ${loc.shortAddress ?? "an unknown place"} ` +
        `(${loc.latitude}, ${loc.longitude})`
    );
  } else {
    await message.reply("I can't see your location — share it from Messages first.");
  }
}
```

`imessage(space)` is a zero-cost typed projection of the same live space — it
doesn't re-fetch anything. If you already hold a `PlatformSpace` typed as
iMessage (e.g. from `imessage(app).messages`), you can call `space.location()`
directly.

### Pairing request + read

A common flow is to *ask* for location, then *read* it once the contact accepts:

```typescript
// 1. Send the Find My request card.
await imessage(space).requestLocation();

// 2. Later — e.g. on a follow-up message — read what they shared.
const loc = await imessage(space).location();
```

There is no "they accepted" event; poll `location()` when you next need the
value. It returns `undefined` until the contact is actually sharing.

---

## Return type — `IMessageLocation`

`location()` resolves `Promise<IMessageLocation | undefined>`. The type is
spectrum-owned (a clean mapping of the SDK's `SharedFriendLocation`), so your
code never imports from `@photon-ai/advanced-imessage` directly.

```typescript
import type { IMessageLocation } from "spectrum-ts/providers/imessage";
```

| Field | Type | Notes |
| --- | --- | --- |
| `address` | `string` | The friend's handle (phone or email) this location belongs to. |
| `name` | `string?` | Display name, when the device knows it. |
| `latitude` | `number?` | Decimal degrees. Absent while a fix is still resolving. |
| `longitude` | `number?` | Decimal degrees. Absent while a fix is still resolving. |
| `accuracy` | `number?` | Horizontal accuracy in **meters**, when reported. |
| `locationType` | `"legacy" \| "live" \| "shallow" \| "unknown"` | Quality/source of the fix. |
| `locationTimestamp` | `Date?` | When the underlying fix was taken. |
| `expiresAt` | `Date?` | When this shared location stops being valid. |
| `isLocatingInProgress` | `boolean` | `true` while the device is actively resolving a fresh fix. |
| `shortAddress` | `string?` | Short human-readable address (e.g. a place name). |
| `longAddress` | `string?` | Full human-readable address. |

> The coordinate fields are optional: a contact can be sharing (so you get an
> `IMessageLocation`, not `undefined`) while a precise fix is still resolving
> (`isLocatingInProgress: true`, `latitude`/`longitude` absent). Always
> null-check the coordinates.

---

## Behavior & edge cases

| Situation | Result |
| --- | --- |
| Friend is sharing a location | resolves an `IMessageLocation` |
| Friend isn't sharing with this account | resolves `undefined` |
| Coordinates not yet resolved | `IMessageLocation` with `isLocatingInProgress: true` and absent lat/long |
| **Group** space | throws `UnsupportedError` — 1:1 only |
| **Local-mode** iMessage | throws `UnsupportedError` — requires remote iMessage |

The friend's address is derived from the 1:1 chat itself (`space.id` is the DM
chat guid, which embeds the participant's handle), so `location()` takes no
arguments. Transient SDK/network errors propagate; only the "not sharing" case
(`sharedFriendLocationNotFound`) is mapped to `undefined`.

Each call is wrapped in a `spectrum.imessage.location` telemetry span tagged
with the provider, space id, and routed phone.

---

## How it fits the framework

`location()` is the first **data-returning space action**. Space actions used to
be void-only "send sugar" (`background`, `requestLocation`, `read`), but they now
mirror platform instance actions: the implementation receives an injected
context (`{ space, client, config, store }`) so it can call the SDK directly, and
its return type is preserved on the public method. A side-effecting action that
returns `Promise<void>` is unchanged; `location()` simply returns its data
instead.

---

## Reference

- `space.location()` action — `src/providers/imessage/index.ts`
- Fetch + `IMessageLocation` type + mapper — `src/providers/imessage/remote/location.ts`
- Remote API re-export — `src/providers/imessage/remote/api.ts`
- Address resolution (`dmAddress` / `toChatGuid`) — `src/providers/imessage/remote/ids.ts`
- Space-action mechanism (ctx injection, return-type preservation) —
  `buildSpace` in `src/platform/build.ts`, `SpaceActionFn` / `SpaceActionMethods`
  in `src/platform/types.ts`
- Underlying SDK — `locations.get` in `@photon-ai/advanced-imessage`
- Request side — `space.requestLocation()` (Find My request card)
