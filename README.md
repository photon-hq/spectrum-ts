# Spectrum

A unified messaging SDK for TypeScript. Write your logic once, deliver it across every platform.

> [!IMPORTANT]
> Spectrum is in early preview. APIs may change between releases. We welcome feedback and contributions as the project matures.

Spectrum abstracts messaging platforms behind a single, fully type-safe API. Receive messages, send responses, manage typing indicators, react to messages, and create conversations — all through one consistent interface, regardless of the underlying platform.

```typescript
import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  providers: [
    imessage.config({ local: true }),
    terminal.config(),
  ],
});

for await (const [space, message] of app.messages) {
  await space.responding(async () => {
    await message.reply("Hello from Spectrum.");
  });
}
```

---

## Table of Contents

- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [Quickstart](#quickstart)
- [Messages](#messages)
- [Content](#content)
- [Spaces](#spaces)
- [Users](#users)
- [Typing Indicators](#typing-indicators)
- [Reactions and Replies](#reactions-and-replies)
- [Platform Narrowing](#platform-narrowing)
- [Platform Providers](#platform-providers)
  - [iMessage](#imessage)
  - [Terminal](#terminal)
- [Custom Events](#custom-events)
- [Lifecycle](#lifecycle)
- [Building a Custom Platform Provider](#building-a-custom-platform-provider)
- [Environment Variables](#environment-variables)
- [Development](#development)

---

## Installation

```bash
bun add spectrum-ts
```

```bash
npm install spectrum-ts
```

Spectrum requires TypeScript 5 or later.

---

## Core Concepts

Spectrum is built around four primitives:

| Primitive | What it represents |
|-----------|-------------------|
| **Message** | An incoming piece of content — text, attachments, or structured data — from any platform. |
| **Space** | A conversation context. A DM, a group chat, a terminal session. You send messages *into* a space. |
| **User** | A participant on a platform, identified by a platform-specific ID. |
| **Platform Provider** | A platform adapter (iMessage, terminal, or your own) that translates platform-specific protocols into Spectrum's unified interface. |

Every message arrives as a `[Space, Message]` tuple. The space gives you the ability to respond; the message gives you the content and metadata.

---

## Quickstart

Send and receive messages across platforms in a few lines.

### Get your credentials

Find your `PROJECT_ID` and `SECRET_KEY` in your project **Settings** on the [dashboard](http://app.photon.codes/)

### Run your first app

```typescript
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

async function main() {
  const app = await Spectrum({
    projectId: "project-id",
    projectSecret: "project-secret",
    providers: [
      imessage.config(),
    ],
  });

  for await (const [space, message] of app.messages) {
    if (message.content.type === "text") {
      console.log(`[${message.platform}] ${message.sender.id}: ${message.content.text}`);
      await space.send("hello world");
    }
  }
}

main();
```


## How it works

### Initialize

```typescript
const app = await Spectrum("your-project-id", "your-project-secret", {
  providers: [imessage.config()],
});
```
Creates your app and connects providers.

### Receive messages
```typescript
for await (const [space, message] of app.messages) {
  // handle message
}
```
Streams messages from all platforms in real time.

### Send replies
```typescript
await space.send("hello world");
```
Respond directly to the conversation.




---

## Messages

Every incoming message conforms to the `Message` interface:

```typescript
interface Message {
  readonly id: string;
  content: Content;
  sender: User;
  space: Space;
  platform: string;
  timestamp: Date;
  react(reaction: string): Promise<void>;
  reply(...content: [ContentInput, ...ContentInput[]]): Promise<void>;
}
```

Messages carry their own context. You can reply to a message directly, react to it, or use its space to send new messages. The `platform` field identifies which platform provider delivered the message.

`Content` is a discriminated union on `type` — `"text"`, `"attachment"`, or `"custom"`. Narrow on `message.content.type` to access the corresponding fields.

---

## Content

Spectrum provides three content builders for constructing outgoing messages. Plain strings are also accepted everywhere a content input is expected, as a shortcut for `text()`.

### Text

```typescript
import { text } from "spectrum-ts";

await space.send(text("Hello, world."));

// Plain strings are equivalent:
await space.send("Hello, world.");
```

### Attachments

Pass a file path or a `Buffer`. MIME types are detected automatically from the file name, or you can specify them explicitly.

```typescript
import { attachment } from "spectrum-ts";

// From a file path
await space.send(attachment("/path/to/photo.jpg"));

// From a buffer with explicit metadata
await space.send(attachment(buffer, {
  name: "report.pdf",
  mimeType: "application/pdf",
}));
```

### Custom

Send platform-specific structured data as JSON. Use this when a platform supports rich content types that don't map to text or attachments.

```typescript
import { custom } from "spectrum-ts";

await space.send(custom({ type: "card", title: "Order Confirmed" }));
```

### Composing multiple content items

All send methods accept a variadic list of content inputs (strings or builders). Items are sent in order as separate messages.

```typescript
await space.send(
  "Here's the file you requested:",
  attachment("/path/to/document.pdf")
);
```

---

## Spaces

A space represents a conversation. Every message arrives with its originating space, and you send responses through it.

```typescript
interface Space {
  readonly id: string;
  readonly __platform: string;
  send(...content: ContentInput[]): Promise<void>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
}
```

You can also create spaces programmatically through [platform narrowing](#platform-narrowing).

---

## Users

Users are identified by a platform-specific ID and can carry additional platform-specific properties.

```typescript
interface User {
  readonly id: string;
  readonly __platform: string;
}
```

Resolve users through a narrowed platform instance:

```typescript
const user = await imessage(app).user("+15551234567");
```

---

## Typing Indicators

### Manual control

```typescript
await space.startTyping();
// ... do work ...
await space.stopTyping();
```

### Automatic with `responding`

The `responding` helper starts a typing indicator before your function runs and stops it when it completes — even if an error is thrown.

```typescript
await space.responding(async () => {
  const result = await generateResponse(message);
  await space.send(text(result));
});
```

This is also available at the instance level:

```typescript
await app.responding(space, async () => {
  await space.send(text("Thinking..."));
});
```

---

## Reactions and Replies

### Reactions

React to any incoming message. The reaction format is platform-specific.

```typescript
await message.react("love");
```

For iMessage, use the built-in tapback constants:

```typescript
import { imessage } from "spectrum-ts/providers/imessage";

await message.react(imessage.tapbacks.laugh);
```

Available tapbacks: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`.

### Threaded replies

Reply directly to a message. On platforms that support threads, this creates a threaded response.

```typescript
await message.reply(text("Replying to your message."));
```

On platforms that don't support reactions or replies, these methods resolve silently as no-ops.

---

## Platform Narrowing

Every platform provider exports a callable that narrows generic Spectrum types to platform-specific ones. This gives you access to platform-specific properties and methods with full type safety.

### Narrowing a Spectrum instance

Returns a `PlatformInstance` with `user()` and `space()` methods:

```typescript
const im = imessage(app);

const user = await im.user("+15551234567");
const space = await im.space(user);
await space.send(text("Hello from a new conversation."));
```

### Narrowing a space

Access platform-specific space properties:

```typescript
const imessageSpace = imessage(space);
console.log(imessageSpace.type); // "dm" | "group"
```

### Narrowing a message

Access platform-specific message properties:

```typescript
const imessageMessage = imessage(message);
```

### Creating group conversations

Pass multiple users to create a group:

```typescript
const im = imessage(app);
const alice = await im.user("+15551111111");
const bob = await im.user("+15552222222");

const group = await im.space(alice, bob);
await group.send(text("Welcome to the group."));
```

---

## Platform Providers

### iMessage

```typescript
import { imessage } from "spectrum-ts/providers/imessage";
```

The iMessage platform provider supports three connection modes:

#### Local mode

Connects directly to the local macOS iMessage database. No network access required. Supports sending text and attachments; reactions, typing indicators, and replies are not available.

```typescript
imessage.config({ local: true })
```

#### Cloud mode (default)

Authenticates with Spectrum Cloud and connects to managed iMessage infrastructure via gRPC. Supports the full feature set: send, receive, typing indicators, reactions, replies, and group chat creation.

```typescript
imessage.config()
```

Authentication is handled automatically. Tokens are renewed at 80% of their TTL.

#### Dedicated mode

Connect directly to one or more iMessage gRPC endpoints with your own tokens.

```typescript
imessage.config({
  clients: [
    { address: "instance-1.example.com:443", token: "your-token" },
    { address: "instance-2.example.com:443", token: "your-token" },
  ],
})
```

#### iMessage space types

iMessage spaces carry a `type` property accessible through narrowing:

```typescript
const im = imessage(space);
if (im.type === "group") {
  // group chat logic
}
```

#### Static properties

| Property | Value |
|----------|-------|
| `imessage.tapbacks.love` | `"love"` |
| `imessage.tapbacks.like` | `"like"` |
| `imessage.tapbacks.dislike` | `"dislike"` |
| `imessage.tapbacks.laugh` | `"laugh"` |
| `imessage.tapbacks.emphasize` | `"emphasize"` |
| `imessage.tapbacks.question` | `"question"` |

### Terminal

```typescript
import { terminal } from "spectrum-ts/providers/terminal";
```

A minimal platform provider that reads from `stdin` and writes to `stdout`. Useful for local development and testing.

```typescript
terminal.config()
```

Each line of input becomes a message. Text content sent to the terminal space is printed to the console. Typing indicators and reactions are no-ops.

---

## Custom Events

Platform providers can emit custom events beyond messages. Access them as async iterables directly on the Spectrum instance:

```typescript
for await (const event of app.typing) {
  console.log(`${event.platform}: typing event received`);
}
```

Custom events are merged across all platform providers that emit them, with a `platform` field added to identify the source. Event streams are created lazily on first access.

---

## Lifecycle

### Graceful shutdown

```typescript
await app.stop();
```

This closes all message streams, disposes custom event streams, and tears down every platform provider client. Spectrum also registers `SIGINT` and `SIGTERM` handlers that trigger graceful shutdown automatically.

### Signal handling

On `SIGINT` or `SIGTERM`, Spectrum initiates shutdown with a 3-second timeout. If cleanup completes in time, the process exits with code 0. Otherwise, it exits with code 1.

---

## Building a Custom Platform Provider

Use `definePlatform` to create a platform provider that plugs into Spectrum's type system and runtime.

```typescript
import { definePlatform } from "spectrum-ts";
import z from "zod";

export const myPlatform = definePlatform("my-platform", {
  // Validate platform provider configuration
  config: z.object({
    apiKey: z.string(),
  }),

  // How to resolve a user from an ID
  user: {
    resolve: async ({ input, client }) => ({
      id: input.userID,
      displayName: await client.lookupUser(input.userID),
    }),
  },

  // How to resolve or create a conversation
  space: {
    resolve: async ({ input, client }) => ({
      id: await client.findOrCreateConversation(input.users.map(u => u.id)),
    }),
  },

  // Client lifecycle
  lifecycle: {
    createClient: async ({ config }) => {
      return new MyPlatformClient(config.apiKey);
    },
    destroyClient: async ({ client }) => {
      await client.disconnect();
    },
  },

  // Event streams
  events: {
    async *messages({ client }) {
      for await (const msg of client.onMessage()) {
        yield {
          id: msg.id,
          content: { type: "text", text: msg.body },
          sender: { id: msg.authorId },
          space: { id: msg.channelId },
          timestamp: new Date(msg.ts),
        };
      }
    },
  },

  // Actions the platform supports
  actions: {
    send: async ({ space, content, client }) => {
      if (content.type === "text") {
        await client.send(space.id, content.text);
      }
    },
    // Optional:
    // startTyping, stopTyping, reactToMessage, replyToMessage
  },

  // Optional: static properties accessible on the platform object
  static: {
    reactions: { thumbsUp: "+1", thumbsDown: "-1" } as const,
  },
});
```

### Platform provider anatomy

| Field | Required | Description |
|-------|----------|-------------|
| `config` | Yes | A Zod schema that validates the object passed to `platform.config()`. When all fields are optional, `platform.config()` can be called with no arguments. |
| `user.resolve` | Yes | Resolves a user from a string ID. Returns at minimum `{ id: string }`. |
| `space.resolve` | Yes | Resolves or creates a conversation. Receives an array of users and optional params. |
| `space.schema` | No | A Zod schema for validating and typing the resolved space. |
| `space.params` | No | A Zod schema for additional space creation parameters. |
| `lifecycle.createClient` | Yes | Creates the platform client. Receives config and optionally project ID and secret (`string` \| `undefined`). |
| `lifecycle.destroyClient` | Yes | Tears down the client on shutdown. |
| `events.messages` | Yes | An async generator that yields incoming messages. |
| `events.[custom]` | No | Additional async generators for platform-specific events. |
| `actions.send` | Yes | Sends a single content item to a space. Invoked once per item when multiple are passed. |
| `actions.startTyping` | No | Shows a typing indicator in a space. |
| `actions.stopTyping` | No | Hides a typing indicator in a space. |
| `actions.reactToMessage` | No | Reacts to a specific message. |
| `actions.replyToMessage` | No | Sends a threaded reply to a specific message. |
| `message.schema` | No | A Zod schema for extra properties on incoming messages. |
| `static` | No | Static properties attached to the platform object (e.g., constants). |

---

## Development

### Prerequisites

- [Bun](https://bun.sh) 1.3.5+
- TypeScript 5+

### Setup

```bash
git clone <repo-url>
cd spectrum-ts
bun install
```

### Build

```bash
bun run build
```

Builds the library with [tsup](https://tsup.egoist.dev) to `packages/spectrum-ts/dist/`. Output is ESM-only with full TypeScript declaration files.

### Watch mode

```bash
bun run dev
```

### Run the example

```bash
bun run examples/basic/index.ts
```

### Lint and format

```bash
bun x ultracite check   # Check for issues
bun x ultracite fix     # Auto-fix
```

---

## License

MIT
