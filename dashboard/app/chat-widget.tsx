"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type ChatReply = {
  request_id?: string;
  status?: string;
  tool?: string;
  answer?: string;
  model?: string;
  scope?: { role?: string; district_id?: string | null; truncated?: boolean };
  sources?: unknown[];
  warnings?: string[];
  error?: { message?: string; request_id?: string };
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  meta?: string;
  error?: boolean;
};

const examples = [
  "วัสดุ 471050004000 ที่คลังคลองเตยเหลือเท่าไร",
  "เขต 5501 ควรเติมวัสดุ 471050004000 เท่าไร",
  "สอบกลับ HU POC-HU-5501-001",
];

const toolNames: Record<string, string> = {
  get_stock_status: "สถานะสต็อก",
  get_replenishment_recommendation: "คำแนะนำเติมวัสดุ",
  get_plan_status: "สถานะแผน",
  get_contract_status: "สถานะสัญญา",
  get_traceability: "การสอบกลับ",
};

export default function ChatWidget({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { id: "welcome", role: "assistant", text: "สวัสดีค่ะ ถามข้อมูล VMI จาก Supabase ได้เลย ฉันจะแสดงตัวเลขพร้อมหน่วยและวันที่ข้อมูลให้ตรวจสอบ" },
  ]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [open, messages]);

  useEffect(() => {
    const minimize = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", minimize);
    return () => window.removeEventListener("keydown", minimize);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(question: string) {
    const message = question.trim();
    if (!message || busy) return;
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: message }]);
    setInput("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as ChatReply;
      if (!response.ok) throw new Error(payload.error?.message ?? `Chat request failed (${response.status})`);
      const source = payload.tool ? toolNames[payload.tool] ?? payload.tool : "Agent";
      const district = payload.scope?.district_id ? ` · เขต ${payload.scope.district_id}` : "";
      const model = payload.model ? ` · ${payload.model}` : "";
      setMessages((current) => [...current, {
        id: payload.request_id ?? crypto.randomUUID(),
        role: "assistant",
        text: payload.answer ?? "ไม่พบคำตอบที่ตรวจสอบได้",
        meta: `${source}${district}${model}`,
      }]);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: error instanceof Error ? error.message : "ไม่สามารถเชื่อมต่อ Agent ได้",
        error: true,
      }]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(input);
  }

  return (
    <aside className={`synapse-chat ${open ? "open" : ""}`} aria-label="SYNAPSE Agent">
      {open && (
        <section className="synapse-chat-panel" role="dialog" aria-modal="false" aria-label="คุยกับ SYNAPSE Agent">
          <header>
            <div className="synapse-chat-avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 0-7 7v3a4 4 0 0 0 4 4h1l2.7 2.2c.5.4 1.3.1 1.3-.6V17h1a4 4 0 0 0 4-4v-3a7 7 0 0 0-7-7Zm-3 8.5a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm6 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z" /></svg>
            </div>
            <div>
              <strong>SYNAPSE Agent</strong>
              <span><i /> เชื่อมต่อข้อมูลตามสิทธิ์ของคุณ</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="ย่อหน้าต่างแชท">—</button>
          </header>

          <div className="synapse-chat-messages" aria-live="polite" aria-busy={busy}>
            {messages.map((message) => (
              <article key={message.id} className={`${message.role} ${message.error ? "error" : ""}`}>
                <p>{message.text}</p>
                {message.meta && <small>{message.meta}</small>}
              </article>
            ))}
            {messages.length === 1 && (
              <div className="synapse-chat-examples">
                <span>ลองถาม</span>
                {examples.map((example) => (
                  <button type="button" key={example} onClick={() => void ask(example)}>{example}</button>
                ))}
              </div>
            )}
            {busy && <div className="synapse-chat-thinking" role="status"><i /><i /><i /><span>กำลังตรวจข้อมูล…</span></div>}
            <div ref={endRef} />
          </div>

          <form onSubmit={submit}>
            <label htmlFor="synapse-chat-input">ถามข้อมูล VMI</label>
            <div>
              <textarea
                id="synapse-chat-input"
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value.slice(0, 2_000))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="เช่น วัสดุ 471050004000 เหลือเท่าไร"
                rows={1}
                disabled={busy}
              />
              {busy ? (
                <button type="button" className="cancel" onClick={() => abortRef.current?.abort()} aria-label="ยกเลิกคำถาม">×</button>
              ) : (
                <button type="submit" disabled={!input.trim()} aria-label="ส่งคำถาม">
                  <svg viewBox="0 0 24 24"><path d="m4 4 17 8-17 8 3-8-3-8Zm3.6 7h8.6L6.4 6.4 7.6 11Zm-1.2 6.6 9.8-4.6H7.6l-1.2 4.6Z" /></svg>
                </button>
              )}
            </div>
            <small>Agent อ่านข้อมูลเท่านั้น · ไม่อนุมัติหรือจ่ายของ</small>
          </form>
        </section>
      )}

      <button
        type="button"
        className="synapse-chat-launcher"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "ย่อ SYNAPSE Agent" : "เปิด SYNAPSE Agent"}
      >
        {open ? <span>×</span> : <svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 0-7 7v3a4 4 0 0 0 4 4h1l2.7 2.2c.5.4 1.3.1 1.3-.6V17h1a4 4 0 0 0 4-4v-3a7 7 0 0 0-7-7Zm-3 8.5a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm6 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z" /></svg>}
      </button>
    </aside>
  );
}
