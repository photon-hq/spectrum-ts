"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { type FormEvent, useMemo, useState } from "react";

export default function ChatPage() {
  const chatId = "demo-chat";
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    []
  );
  const { error, messages, sendMessage, status } = useChat({
    id: chatId,
    transport,
  });
  const isSending = status === "submitted" || status === "streaming";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isSending) {
      return;
    }
    sendMessage({ text });
    setInput("");
  }

  return (
    <main className="shell">
      <section className="header">
        <p className="eyebrow">Photon Spectrum + Vercel AI SDK</p>
        <h1>useChat through a Spectrum worker</h1>
        <p>
          This page uses Vercel AI SDK `useChat`. The route forwards each
          message to a long-running Spectrum worker through `webBridge`.
        </p>
      </section>

      <section aria-label="Chat messages" className="chat">
        {messages.length === 0 ? (
          <div className="empty">Send a message to the Spectrum worker.</div>
        ) : (
          messages.map((message) => (
            <article
              className="message"
              data-role={message.role}
              key={message.id}
            >
              <div className="role">{message.role}</div>
              <div className="content">
                {message.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")}
              </div>
            </article>
          ))
        )}
      </section>

      {error ? <p className="error">{error.message}</p> : null}

      <form className="composer" onSubmit={handleSubmit}>
        <label className="srOnly" htmlFor="message">
          Message
        </label>
        <input
          autoComplete="off"
          id="message"
          name="message"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask the Spectrum worker..."
          value={input}
        />
        <button disabled={isSending || input.trim().length === 0} type="submit">
          {isSending ? "Sending" : "Send"}
        </button>
      </form>
    </main>
  );
}
