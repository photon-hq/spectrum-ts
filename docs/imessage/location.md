# iMessage — shared location (`space.location()`)

iMessage can share a contact's **Find My** location. Spectrum surfaces this as a
set of iMessage-only actions, at two levels:

| Action | Level | Direction | What it does |
| --- | --- | --- | --- |
| `space.requestLocation()` | space | **send** | Drops a "share your location" Find My request card into the chat (fire-and-forget). |
| `space.location()` | space | **read** | Fetches *one* friend's *currently shared* location for a 1:1 chat. |
| `imessage(app).getAllLocations()` | instance | **read** | Fetches *every* friend currently sharing a location with the account. |

This page covers the **read** side at both levels. `location()` calls the
underlying `@photon-ai/advanced-imessage` `locations.get` for a single DM and
resolves the friend's latest known position (or `undefined` if they aren't
sharing); `getAllLocations()` calls `locations.list` and resolves *all* of them.

> All three are **iMessage-only** and require **remote** iMessage (a real
> `@photon-ai/advanced-imessage` client). They are not part of the universal
> `Content`/`Space` surface — reach them through the iMessage projection, which
> is where TypeScript knows they exist: the **space** actions via `imessage(space)`
> (1:1 chats only), and the account-wide read via `imessage(app)`.

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

## Account-wide read — `imessage(app).getAllLocations()`

`location()` answers "where is *this* friend?" for a single DM. Its instance-level
companion answers "who is sharing with me *at all*?" — it lists every friend
currently sharing a Find My location with the account in one call.

Because it is account-wide rather than tied to a chat, it hangs off the **iMessage
instance** (`imessage(app)` / `imessage(spectrum)`), not the space projection:

```typescript
const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config({ /* … */ })],
});

// Every friend currently sharing — no chat needed.
const locations = await imessage(app).getAllLocations();

for (const loc of locations) {
  console.log(`${loc.name ?? loc.address}: ${loc.shortAddress ?? "(resolving…)"}`);
}
```

It resolves `Promise<IMessageLocation[]>` — the same per-friend shape as
`location()`, just many of them — and returns an empty array when nobody is
sharing (there is **no** `undefined` case). Use each entry's `address` field to map
a result back to a contact or chat.

### Multiple numbers

`getAllLocations(phone?)` takes an optional phone to scope the lookup. Shared
locations are per-account, so the no-arg form unions every configured number:

| Mode | `getAllLocations()` | `getAllLocations(phone)` |
| --- | --- | --- |
| Single number / shared | lists that account | same (phone ignored in shared mode) |
| Multiple numbers | **aggregates across every configured number** | lists just that number's account |

A friend sharing with two of your numbers therefore appears once per number in the
aggregated result.

### Behavior & edge cases

| Situation | Result |
| --- | --- |
| One or more friends sharing | resolves `IMessageLocation[]` |
| Nobody sharing | resolves `[]` (never `undefined`) |
| Coordinates not yet resolved | entries with `isLocatingInProgress: true` and absent lat/long |
| **Local-mode** iMessage | throws `UnsupportedError` — requires remote iMessage |

Unlike `location()` there is **no group/1:1 restriction** — it isn't tied to a chat
at all. Each call is wrapped in a `spectrum.imessage.getAllLocations` telemetry span
tagged with the provider and the routed phone (`"all"` when aggregating).

---

## How it fits the framework

`location()` is the first **data-returning space action**. Space actions used to
be void-only "send sugar" (`background`, `requestLocation`, `read`), but they now
mirror platform instance actions: the implementation receives an injected
context (`{ space, client, config, store }`) so it can call the SDK directly, and
its return type is preserved on the public method. A side-effecting action that
returns `Promise<void>` is unchanged; `location()` simply returns its data
instead.

`getAllLocations()` is the **instance-level** analog: it's a plain iMessage
*instance action* (the same mechanism behind `imessage(app).getAttachment()`),
declared in the provider's top-level `actions:` block. It receives an injected
`{ client, config, store }` context — no `space`, since it isn't bound to one — and
its `Promise<IMessageLocation[]>` return type flows straight through to the public
method via `InstanceActionMethods`.

---

## Reference

- `space.location()` action + `imessage(app).getAllLocations()` instance action —
  `src/providers/imessage/index.ts`
- Fetchers (`getLocation` / `getAllLocations`) + `IMessageLocation` type + mapper —
  `src/providers/imessage/remote/location.ts`
- Remote API re-exports — `src/providers/imessage/remote/api.ts`
- Address resolution (`dmAddress` / `toChatGuid`) — `src/providers/imessage/remote/ids.ts`
- Space-action mechanism (ctx injection, return-type preservation) —
  `buildSpace` in `src/platform/build.ts`, `SpaceActionFn` / `SpaceActionMethods`
  in `src/platform/types.ts`
- Instance-action mechanism — `InstanceActionFn` / `InstanceActionMethods` in
  `src/platform/types.ts`
- Underlying SDK — `locations.get` / `locations.list` in `@photon-ai/advanced-imessage`
- Request side — `space.requestLocation()` (Find My request card)
