import { useChat } from "@ai-sdk/react";
import { type FormEvent, useMemo, useState } from "react";
import { SpectrumChatTransport } from "spectrum-ts/adapters/ai-sdk";
import "./style.css";

export function App() {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () =>
      new SpectrumChatTransport({
        endpoint: "http://127.0.0.1:8787/ai-sdk/chat",
      }),
    []
  );
  const { error, messages, sendMessage, status } = useChat({ transport });
  const isSending = status === "submitted" || status === "streaming";

  function submit(event: FormEvent<HTMLFormElement>) {
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
      <header className="header">
        <p className="eyebrow">Spectrum webChat</p>
        <h1>Vercel AI SDK through Spectrum</h1>
        <p>
          The UI keeps `useChat`; the response comes from the local Spectrum
          runtime.
        </p>
      </header>

      <section aria-label="Messages" className="messages">
        {messages.length === 0 ? (
          <p className="empty">Send a message to the Spectrum runtime.</p>
        ) : (
          messages.map((message) => (
            <article
              className="message"
              data-role={message.role}
              key={message.id}
            >
              <strong>{message.role}</strong>
              <p>
                {message.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")}
              </p>
            </article>
          ))
        )}
      </section>

      {error ? <p className="error">{error.message}</p> : null}

      <form className="composer" onSubmit={submit}>
        <label htmlFor="message">Message</label>
        <input
          autoComplete="off"
          id="message"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask through Spectrum..."
          value={input}
        />
        <button disabled={isSending || input.trim().length === 0} type="submit">
          {isSending ? "Sending" : "Send"}
        </button>
      </form>
    </main>
  );
}
