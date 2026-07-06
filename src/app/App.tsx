import { useState, useRef, useEffect } from "react";
import { ArrowUp, Sparkles, X, ChevronRight, Loader2, FileText, Menu, Plus, MessageSquare, Sun, Moon, Download, FileDown, Pencil, Eye } from "lucide-react";
import { fonts } from "../config/fonts";


const BLUE = "var(--color-primary)";
const BLUE_LIGHT = "color-mix(in srgb, var(--color-primary) 10%, transparent)";
const BLUE_BORDER = "color-mix(in srgb, var(--color-primary) 32%, transparent)";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";


type Phase =
  | "landing"
  | "classifying"
  | "questioning"
  | "form"
  | "researching"
  | "generating"
  | "prd"
  | "failed";

type QuestionType = "single_select" | "multi_select" | "text";

interface Question {
  id: string;
  label: string;
  help: string;
  type: QuestionType;
  options: string[];
  allow_custom: boolean;
}

interface QuestionsSpec {
  needs_clarification: boolean;
  questions: Question[];
}

interface Answer {
  choice?: string;
  choices?: string[];
  custom?: string;
}

interface StoredPRD {
  id: string;
  prompt: string;
  classification: Record<string, unknown>;
  markdown: string;
  createdAt: string;
}

const HISTORY_STORAGE_KEY = "prd-manager-history";

function readHistory(): StoredPRD[] {
  const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${HISTORY_STORAGE_KEY} is not an array`);
  }
  return parsed as StoredPRD[];
}

function writeHistory(items: StoredPRD[]) {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
}

function saveHistoryItem(item: StoredPRD): StoredPRD[] {
  const existing = readHistory().filter((entry) => entry.id !== item.id);
  const next = [item, ...existing];
  writeHistory(next);
  return next;
}

function filenameFromPrompt(prompt: string, ext: string) {
  const base = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "prd";
  return `${base}.${ext}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const suggestions = [
  "A unified data lakehouse for our analytics teams",
  "Customer-facing self-service portal with SSO",
  "Internal developer platform with CI/CD orchestration",
  "Real-time inventory management for 40 warehouses",
];

const humanize = (s: string) => s.replaceAll("_", " ");

function ClassificationCard({ data }: { data: Record<string, unknown> }) {
  const arr = (k: string): string[] => (Array.isArray(data[k]) ? (data[k] as string[]) : []);
  const str = (k: string): string[] => (typeof data[k] === "string" && data[k] ? [data[k] as string] : []);
  
  const chips = [
    { label: "intent", values: str("intent") },
    { label: "platforms", values: arr("platforms") },
    { label: "users", values: arr("users") },
    { label: "stage", values: str("stage") },
    { label: "complexity", values: str("complexity") },
    { label: "data", values: str("data_sensitivity") },
    { label: "ai risk", values: str("ai_risk") },
    { label: "risks", values: arr("risk_flags") },
  ].flatMap(c => c.values.map(v => ({ label: c.label, value: v })));

  return (
    <div className="rounded-2xl bg-card p-3 flex items-center gap-4 overflow-x-auto hide-scrollbar border-[1.5px] border-primary/20 shadow-md shadow-primary/10">
      <span className="text-[10px] uppercase tracking-widest font-bold whitespace-nowrap flex-none" style={{ fontFamily: "'JetBrains Mono', monospace", color: BLUE }}>
        Classification
      </span>
      {chips.length > 0 ? chips.map((c, i) => (
        <span key={i} className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap flex-none border border-primary/30 bg-primary/10 text-primary">
          <span className="opacity-60 mr-1">{c.label}:</span>{humanize(c.value)}
        </span>
      )) : (
        <span className="text-[10px] text-muted-foreground/60">Processing details...</span>
      )}
    </div>
  );
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request to ${url} failed`);
  return data as T;
}

function isAnswered(q: Question, a: Answer | undefined): boolean {
  if (!a) return false;
  const custom = (a.custom ?? "").trim();
  if (q.type === "text") return custom.length > 0;
  if (q.type === "single_select") return !!a.choice || (q.allow_custom && custom.length > 0);
  return (a.choices?.length ?? 0) > 0 || (q.allow_custom && custom.length > 0);
}

function answerValue(q: Question, a: Answer): string | string[] {
  const custom = (a.custom ?? "").trim();
  if (q.type === "text") return custom;
  if (q.type === "single_select") return custom || a.choice || "";
  const vals = [...(a.choices ?? [])];
  if (custom) vals.push(custom);
  return vals;
}

export default function App() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("landing");
  const [submittedText, setSubmittedText] = useState("");
  const [classification, setClassification] = useState<Record<string, unknown> | null>(null);
  const [spec, setSpec] = useState<QuestionsSpec | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [prd, setPrd] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const [genStatus, setGenStatus] = useState("");
  const [isEditingPrd, setIsEditingPrd] = useState(false);
  const [editSaveStatus, setEditSaveStatus] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prdDocRef = useRef<HTMLDivElement>(null);
  const printPrdRef = useRef<HTMLDivElement>(null);

  const submitted = phase !== "landing";

  useEffect(() => {
    if (phase === "landing") {
      if (textareaRef.current) textareaRef.current.focus();
      setSidebarOpen(true);
    } else {
      setSidebarOpen(false);
    }
  }, [phase]);

  const [detailedMode, setDetailedMode] = useState(true);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isDark, setIsDark] = useState(true);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);
  const [historyList, setHistoryList] = useState<StoredPRD[]>([]);

  useEffect(() => {
    try {
      setHistoryList(readHistory());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  }, []);

  const loadHistoryItem = async (id: string) => {
    setCurrentSessionId(id);
    try {
      const data = readHistory().find((entry) => entry.id === id);
      if (!data) throw new Error(`PRD not found in localStorage: ${id}`);
      setSubmittedText(data.prompt);
      setClassification(data.classification);
      setPrd(data.markdown);
      setIsEditingPrd(false);
      setEditSaveStatus("Saved");
      setPhase("prd");
      setPanelVisible(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  };

  useEffect(() => {
    if (phase !== "prd" || !currentSessionId || !classification || !prd.trim()) return;
    setEditSaveStatus("Saving...");
    const timer = window.setTimeout(() => {
      try {
        const existing = readHistory().find((entry) => entry.id === currentSessionId);
        const nextHistory = saveHistoryItem({
          id: currentSessionId,
          prompt: submittedText,
          classification,
          markdown: prd,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        });
        setHistoryList(nextHistory);
        setEditSaveStatus("Saved");
      } catch (e) {
        setEditSaveStatus(e instanceof Error ? e.message : "Save failed");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [phase, currentSessionId, classification, prd, submittedText]);

  const downloadMarkdown = () => {
    if (!prd.trim()) return;
    const blob = new Blob([prd], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameFromPrompt(submittedText, "md");
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    if (!prd.trim()) return;
    const html = printPrdRef.current?.innerHTML || `<pre>${escapeHtml(prd)}</pre>`;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("PDF export blocked by popup settings");
      return;
    }
    printWindow.document.write(`<!doctype html>
<html>
<head>
  <title>${escapeHtml(filenameFromPrompt(submittedText, "pdf"))}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; margin: 40px; line-height: 1.55; }
    h1 { font-size: 28px; margin: 0 0 18px; }
    h2 { font-size: 20px; margin-top: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
    h3 { font-size: 16px; margin-top: 22px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; vertical-align: top; }
    th { background: #f3f4f6; }
    blockquote { border-left: 3px solid #d1d5db; color: #4b5563; margin-left: 0; padding-left: 12px; }
    code { background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
    pre { white-space: pre-wrap; }
  </style>
</head>
<body>${html}</body>
</html>`);
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 250);
  };

  


  const triggerGeneratePrd = async (promptToUse: string, clsToUse: Record<string, unknown>, payload: Record<string, string | string[]>) => {
    setError(null);
    setPrd("");
    setGenStatus("Starting…");
    setIsEditingPrd(false);
    setEditSaveStatus("");
    setPhase("researching");
    try {
      const res = await fetch("/api/generate-prd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptToUse,
          classification: clsToUse,
          answers: payload,
        }),
      });
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({ error: "Stream failed" }));
        throw new Error(errData.error || "Stream failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;
      let fullMarkdown = "";
      const handleStreamMessage = (msg: string) => {
        if (!msg.trim()) return;
        let event = "";
        let data = "";
        for (const line of msg.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (!event || !data) {
          throw new Error(`Malformed stream event: ${msg}`);
        }
        const parsed = JSON.parse(data);
        switch (event) {
          case "status":
            setGenStatus(parsed.message || "");
            if (parsed.phase === "researching") setPhase("researching");
            else if (parsed.phase === "generating") setPhase("generating");
            break;
          case "chunk":
            if (typeof parsed.content !== "string") {
              throw new Error(`Malformed chunk event: ${msg}`);
            }
            fullMarkdown += parsed.content;
            setPrd((prev) => prev + parsed.content);
            break;
          case "done":
            break;
          case "error":
            streamError = parsed.message || "Generation failed";
            break;
          default:
            throw new Error(`Unknown stream event: ${event}`);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split("\n\n");
        buffer = messages.pop() || "";
        for (const msg of messages) {
          handleStreamMessage(msg);
        }
      }
      if (buffer.trim()) handleStreamMessage(buffer);
      if (streamError) throw new Error(streamError);
      const id = currentSessionId ?? crypto.randomUUID();
      const nextHistory = saveHistoryItem({
        id,
        prompt: promptToUse,
        classification: clsToUse,
        markdown: fullMarkdown,
        createdAt: new Date().toISOString(),
      });
      setCurrentSessionId(id);
      setHistoryList(nextHistory);
      setEditSaveStatus("Saved");
      setPhase("prd");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(spec ? "form" : "failed");
    }
  };

  const handleGenerate = () => {
    if (!classification) return;
    const payload: Record<string, string | string[]> = {};
    for (const q of spec?.questions ?? []) {
      const a = answers[q.id];
      if (a) payload[q.label] = answerValue(q, a);
    }
    triggerGeneratePrd(submittedText, classification, payload);
  };

  const handleSubmit = async () => {
    if (!input.trim() || phase !== "landing") return;
    const prompt = input.trim();
    setSubmittedText(prompt);
    setError(null);
    setPhase("classifying");
    setTimeout(() => setPanelVisible(true), 80);
    try {
      const cls = await postJSON<Record<string, unknown>>("/api/classify", { prompt });
      setClassification(cls);
      
      if (!detailedMode) {
        triggerGeneratePrd(prompt, cls, {});
        return;
      }

      setPhase("questioning");
      const q = await postJSON<QuestionsSpec>("/api/questions", {
        prompt,
        classification: cls,
      });
      setSpec(q);
      setPhase("form");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleNewChat = () => {
    setCurrentSessionId(null);
    setPanelVisible(false);
    setTimeout(() => {
      setPhase("landing");
      setSubmittedText("");
      setClassification(null);
      setSpec(null);
      setAnswers({});
      setPrd("");
      setError(null);
      setInput("");
      setGenStatus("");
      setIsEditingPrd(false);
      setEditSaveStatus("");
    }, 300);
  };

  const setChoice = (id: string, choice: string) =>
    setAnswers((p) => ({ ...p, [id]: { ...p[id], choice } }));
  const toggleChoice = (id: string, opt: string) =>
    setAnswers((p) => {
      const cur = p[id]?.choices ?? [];
      const next = cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt];
      return { ...p, [id]: { ...p[id], choices: next } };
    });
  const setCustom = (id: string, custom: string) =>
    setAnswers((p) => ({ ...p, [id]: { ...p[id], custom } }));

  const questions = (spec?.questions ?? []).filter(q => q.options && q.options.length > 0);
  const answeredCount = questions.filter((q) => isAnswered(q, answers[q.id])).length;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;
  const noQuestions = phase === "form" && spec !== null && questions.length === 0;
  const canGenerate = (allAnswered || noQuestions) && phase === "form";

  const statusLine = () => {
    switch (phase) {
      case "classifying":
        return "Classifying your requirement…";
      case "questioning":
        return "Working out what I still need to know…";
      case "researching":
        return genStatus || "Researching real-world context…";
      case "generating":
        return genStatus || "Writing your PRD…";
      default:
        return null;
    }
  };

  return (
    
    <div className="h-screen bg-background text-foreground flex overflow-hidden" style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" }}>
            {/* FLOATING MENU BUTTON WHEN SIDEBAR CLOSED */}
      {!sidebarOpen && (
        <button 
          onClick={() => setSidebarOpen(true)} 
          className="absolute top-4 left-4 z-50 p-2 rounded-md hover:bg-muted text-muted-foreground transition-colors bg-card border border-white/5 shadow-sm"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* SIDEBAR */}
      <div className={`flex flex-col bg-sidebar border-r border-white/5 transition-all duration-300 ease-in-out z-40 relative ${sidebarOpen ? "w-64 flex-none" : "w-0 overflow-hidden opacity-0"}`}>
        {/* SIDEBAR HEADER (Moved from old main nav) */}
        <div className="p-4 flex flex-col gap-3 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-6 h-6 rounded flex items-center justify-center bg-primary">
                <Sparkles className="w-3.5 h-3.5 text-primary-foreground" />
              </div>
              <span className={`${fonts.brand} font-semibold tracking-tight text-foreground text-sm`}>
                PRD Manager
              </span>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-muted rounded-md text-muted-foreground">
               <Menu className="w-4 h-4" />
            </button>
          </div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Take home assessment</span>
        </div>
        
        {/* New Chat Button */}
        <div className="p-3">
          <button onClick={handleNewChat} className={`w-full flex items-center gap-2 px-3 py-2 bg-card border border-white/5 rounded-xl hover:bg-muted/50 transition-all ${fonts.sidebarItem} font-medium text-foreground`}>
             <Plus className="w-4 h-4 text-primary" /> New Project
          </button>
        </div>
        
        {/* Chats List */}
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1 hide-scrollbar">
          <div className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wider mb-2 px-2">Recent</div>
          {historyList.map(h => (
            <button key={h.id} onClick={() => loadHistoryItem(h.id)} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted/50 transition-colors text-left group">
              <MessageSquare className="w-4 h-4 text-muted-foreground/60 group-hover:text-primary flex-none" />
              <span className={`${fonts.sidebarItem} text-muted-foreground truncate`}>{h.prompt}</span>
            </button>
          ))}
        </div>

        {/* SIDEBAR FOOTER (Moved from old main nav) */}
        <div className="p-4 flex flex-col gap-4 border-t border-white/5 bg-sidebar">
           <div className="flex items-center justify-between">
             <button onClick={() => setIsDark(!isDark)} className="p-2 rounded-full hover:bg-muted transition-colors text-muted-foreground ">
                {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
             </button>
             <button className="text-xs px-4 py-2 rounded-full font-semibold transition-all hover:opacity-90 bg-primary text-primary-foreground">
                Sign in
             </button>
           </div>
        </div>
      </div>
      
      {/* MAIN LAYOUT */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        <div className="flex-1 flex overflow-hidden relative">
          {/* Subtle breathing glow effect */}
          <div className="gemini-glow"></div>

        {/* LEFT — chat pane */}
        <div className="flex flex-col transition-all duration-300 ease-in-out bg-background" style={{ width: panelVisible ? "46%" : "100%" }}>
          {!submitted ? (
            /* ── LANDING ── */
            <div className="flex-1 flex flex-col items-center justify-center px-8 pb-12">
              <div className="w-11 h-11 rounded-2xl flex items-center justify-center mb-7 shadow-sm bg-primary/10 border border-primary/30">
                <Sparkles className="w-5 h-5 text-primary" />
              </div>
              <h1 className={`${fonts.landingHeading} font-normal text-center mb-2 leading-snug`} style={{ color: "var(--color-foreground)" }}>
                Describe your project.
              </h1>
              <p className={`${fonts.landingSubtext} text-center mb-10 max-w-sm leading-relaxed text-muted-foreground`}>
                Our AI agents will classify it, ask what's missing, and generate a full PRD — ready for your team to review.
              </p>
              <div className="w-full max-w-xl">
                <div className="rounded-2xl bg-card p-1 transition-shadow focus-within:shadow-lg border-[1.5px] border-primary/30 shadow-md shadow-primary/10">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="e.g. A unified analytics platform for internal BI teams across 12 regions…"
                    rows={3}
                    className={`w-full bg-transparent ${fonts.landingInput} text-foreground placeholder:text-muted-foreground px-6 pt-4 pb-2 resize-none outline-none leading-relaxed`}
                  />
                  <div className="flex items-center justify-between px-3 pb-2 pt-1">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        Press ↵ to continue
                      </span>
                      <label className="flex items-center gap-2 cursor-pointer group">
                        <div className="relative flex items-center">
                          <input 
                            type="checkbox" 
                            checked={detailedMode} 
                            onChange={(e) => setDetailedMode(e.target.checked)} 
                            className="sr-only"
                          />
                          <div className={`block w-8 h-4.5 rounded-full transition-colors duration-200 ease-in-out ${detailedMode ? 'bg-primary' : 'bg-muted-foreground/30'}`}></div>
                          <div className={`absolute left-0.5 bg-card w-3.5 h-3.5 rounded-full shadow-sm transition-transform duration-200 ease-in-out ${detailedMode ? 'translate-x-3.5' : 'translate-x-0'}`}></div>
                        </div>
                        <span className="text-[10px] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                          Detailed mode
                        </span>
                      </label>
                    </div>
                    <button onClick={handleSubmit} disabled={!input.trim()} className="w-8 h-8 rounded-xl flex items-center justify-center transition-all disabled:opacity-25 hover:opacity-80 bg-primary">
                      <ArrowUp className="w-4 h-4 text-primary-foreground" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ── CONVERSATION ── */
            <div className="flex-1 flex flex-col">
              <div className="flex-1 overflow-y-auto px-7 py-8 flex flex-col gap-4">
                <div className="flex justify-end">
                  <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-br-sm text-sm leading-relaxed font-medium bg-[#1e1f20] border-0 text-foreground">
                    {submittedText}
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <div className="w-7 h-7 rounded-lg flex-none flex items-center justify-center mt-0.5 shadow-sm bg-primary shrink-0">
                    <Sparkles className="w-3.5 h-3.5 text-primary-foreground" />
                  </div>
                  <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm text-sm leading-relaxed bg-card border-[1.5px] border-primary/30 text-foreground shadow-sm shadow-primary/10">
                    {statusLine() ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        {statusLine()}
                      </span>
                    ) : phase === "failed" ? (
                      "The request failed before the PRD could be generated."
                    ) : noQuestions ? (
                      "Your prompt is clear enough — I have what I need. Ready to generate your PRD."
                    ) : questions.length > 0 ? (
                      <>
                        Before I generate your PRD, a few questions to scope it correctly.
                        <span className="block mt-2 text-xs font-medium" style={{ fontFamily: "'JetBrains Mono', monospace", color: BLUE }}>
                          {answeredCount}/{questions.length} answered →
                        </span>
                      </>
                    ) : (
                      "Got it."
                    )}
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex-none flex items-center justify-center mt-0.5" style={{ background: "var(--color-destructive)" }}>
                      <X className="w-3.5 h-3.5 text-primary-foreground" />
                    </div>
                    <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm text-sm leading-relaxed bg-card" style={{ border: "1.5px solid var(--color-destructive)", color: "var(--color-destructive)" }}>
                      {error}
                    </div>
                  </div>
                )}

                {phase === "prd" && (
                  <div className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex-none flex items-center justify-center mt-0.5 shadow-sm bg-primary">
                      <Sparkles className="w-3.5 h-3.5 text-primary-foreground" />
                    </div>
                    <div className="px-4 py-3 rounded-2xl rounded-tl-sm text-sm leading-relaxed bg-card" style={{ border: `1.5px solid ${BLUE_BORDER}`, boxShadow: "0 2px 8px color-mix(in srgb, var(--color-primary) 8%, transparent)" }}>
                      <span className="text-foreground font-semibold">Done.</span>
                      <span className="text-muted-foreground"> Your PRD is on the right.</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-none px-7 py-4 bg-card border-t border-white/5">
                <div className="flex items-center gap-3 rounded-xl bg-background px-4 py-2.5 border border-primary/30">
                  <input type="text" disabled placeholder="Add more context or ask a question…" className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none" />
                  <button disabled className="w-7 h-7 rounded-lg flex items-center justify-center opacity-40 bg-primary">
                    <ArrowUp className="w-3.5 h-3.5 text-primary-foreground" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — form / PRD panel */}
        <div className="flex-none flex flex-col overflow-hidden transition-all duration-300 ease-in-out" style={{ width: panelVisible ? "54%" : "0%", opacity: panelVisible ? 1 : 0, borderLeft: `2px solid color-mix(in srgb, var(--color-primary) 28%, transparent)`, background: (phase === "prd" || phase === "generating") ? "var(--color-card)" : "var(--color-secondary)" }}>
          {/* header */}
          <div className="flex-none flex items-center justify-between px-7 py-5 bg-card" style={{ borderBottom: `2px solid color-mix(in srgb, var(--color-primary) 18%, transparent)` }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest mb-1 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: BLUE }}>
                {phase === "prd" || phase === "generating" ? "Product Requirements" : phase === "researching" ? "Research" : "Scoping Questions"}
              </div>
              <div className="text-sm font-bold text-foreground">
                {phase === "prd" ? (isEditingPrd ? `Editing PRD${editSaveStatus ? ` · ${editSaveStatus}` : ""}` : `Generated PRD${editSaveStatus ? ` · ${editSaveStatus}` : ""}`) : phase === "generating" ? genStatus || "Writing…" : phase === "researching" ? genStatus || "Researching…" : "Just a few questions to clarify requirement"}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {phase === "prd" && prd.trim() && (
                <>
                  <button
                    onClick={() => setIsEditingPrd((value) => !value)}
                    className="h-8 px-3 rounded-lg flex items-center gap-1.5 transition-all hover:bg-muted text-muted-foreground hover:text-foreground border border-white/10"
                    title={isEditingPrd ? "Preview PRD" : "Edit PRD"}
                  >
                    {isEditingPrd ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                    <span className="text-xs font-medium">{isEditingPrd ? "Preview" : "Edit"}</span>
                  </button>
                  <button
                    onClick={downloadMarkdown}
                    className="h-8 px-3 rounded-lg flex items-center gap-1.5 transition-all hover:bg-muted text-muted-foreground hover:text-foreground border border-white/10"
                    title="Download Markdown"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span className="text-xs font-medium">MD</span>
                  </button>
                  <button
                    onClick={exportPdf}
                    className="h-8 px-3 rounded-lg flex items-center gap-1.5 transition-all hover:bg-muted text-muted-foreground hover:text-foreground border border-white/10"
                    title="Export PDF"
                  >
                    <FileDown className="w-3.5 h-3.5" />
                    <span className="text-xs font-medium">PDF</span>
                  </button>
                </>
              )}
              {phase !== "prd" && questions.length > 0 && (
                <>
                  <span className="text-xs text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {answeredCount} / {questions.length}
                  </span>
                  <div className="w-24 h-1.5 rounded-full overflow-hidden bg-primary/10">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(answeredCount / questions.length) * 100}%`, background: BLUE }} />
                  </div>
                </>
              )}
              <button onClick={handleNewChat} className="w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:bg-muted text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* body */}
          {phase === "prd" || (phase === "generating" && prd) ? (
            <div className="flex-1 overflow-y-auto px-10 py-8">
              {isEditingPrd && phase === "prd" ? (
                <textarea
                  value={prd}
                  onChange={(e) => setPrd(e.target.value)}
                  className="w-full min-h-full resize-none bg-background text-foreground outline-none border border-primary/20 rounded-xl px-5 py-4 text-sm leading-relaxed font-mono shadow-inner"
                  style={{ minHeight: "calc(100vh - 190px)" }}
                  spellCheck={true}
                />
              ) : (
                <div ref={prdDocRef} className="prd-doc max-w-3xl mx-auto text-sm leading-relaxed" style={{ color: "var(--color-foreground)" }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd}</ReactMarkdown>
                  {phase === "generating" && (
                    <span className="inline-flex items-center gap-2 mt-4 text-xs text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin text-primary" />
                      {genStatus}
                    </span>
                  )}
                </div>
              )}
              <div ref={printPrdRef} className="prd-doc hidden">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd}</ReactMarkdown>
              </div>
            </div>
          ) : phase === "researching" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm font-medium text-muted-foreground">{genStatus || "Researching real-world context…"}</p>
              <p className="text-xs max-w-sm text-muted-foreground/70">Searching for real use cases, industry metrics, competitor features, and regulatory requirements.</p>
            </div>
          ) : phase === "classifying" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{statusLine()}</p>
            </div>
          ) : phase === "questioning" ? (
            <div className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-5">
              {classification && <ClassificationCard data={classification} />}
              <div className="flex items-center justify-center gap-2.5 py-4">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">{statusLine()}</span>
              </div>
            </div>
          ) : phase === "failed" ? (
            <div className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-5">
              {classification && <ClassificationCard data={classification} />}
              <div className="flex flex-col items-center gap-3 text-center px-8 py-6">
                <div className="w-11 h-11 rounded-2xl flex items-center justify-center bg-destructive/10 border border-destructive">
                  <X className="w-5 h-5 text-destructive" />
                </div>
                <p className="text-sm max-w-xs text-muted-foreground">
                  {error || "The request failed. Start a new project and try again."}
                </p>
              </div>
            </div>
          ) : noQuestions ? (
            <div className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-5">
              {classification && <ClassificationCard data={classification} />}
              <div className="flex flex-col items-center gap-3 text-center px-8 py-6">
                <div className="w-11 h-11 rounded-2xl flex items-center justify-center bg-primary/10 border border-primary/30">
                  <FileText className="w-5 h-5 text-primary" />
                </div>
                <p className="text-sm max-w-xs text-muted-foreground">
                  No clarifying questions needed — your prompt is specific enough. Generate the PRD whenever you're ready.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-5">
              {classification && <ClassificationCard data={classification} />}
              <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-5">
                {questions.map((q, i) => {
                  const a = answers[q.id];
                  const done = isAnswered(q, a);
                  return (
                    <div key={q.id} className="rounded-2xl bg-card p-5 transition-shadow" style={{ border: done ? `2px solid ${BLUE}` : `1.5px solid color-mix(in srgb, var(--color-primary) 22%, transparent)`, boxShadow: "0 2px 10px color-mix(in srgb, var(--color-primary) 9%, transparent)" }}>
                      <div className="flex items-start gap-3 mb-1">
                        <span className="w-5 h-5 rounded-full flex-none flex items-center justify-center text-[10px] font-bold mt-0.5" style={{ background: done ? BLUE : BLUE_LIGHT, color: done ? "#ffffff" : BLUE, fontFamily: "'JetBrains Mono', monospace" }}>
                          {done ? "✓" : i + 1}
                        </span>
                        <p className="text-sm font-medium text-foreground leading-snug">{q.label}</p>
                      </div>
                      {q.help && <p className="text-xs ml-8 mb-3 text-muted-foreground">{q.help}</p>}

                      <div className="ml-8 mt-3 flex flex-col gap-2">
                        {q.type === "single_select" && (
                          <select
                            value={a?.choice ?? ""}
                            onChange={(e) => setChoice(q.id, e.target.value)}
                            className="text-sm px-3 py-2 rounded-xl bg-card outline-none"
                            style={{ border: `1.5px solid ${BLUE_BORDER}`, color: "var(--color-primary)" }}
                          >
                            <option value="" disabled>Select one…</option>
                            {q.options.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        )}

                        {q.type === "multi_select" && (
                          <div className="flex flex-col gap-1.5">
                            {q.options.map((opt) => {
                              const checked = a?.choices?.includes(opt) ?? false;
                              return (
                                <label key={opt} className="flex items-center gap-2.5 text-sm cursor-pointer px-3 py-1.5 rounded-lg" style={{ border: `1px solid ${checked ? BLUE : "color-mix(in srgb, var(--color-primary) 20%, transparent)"}`, background: checked ? BLUE_LIGHT : "transparent", color: "var(--color-primary)" }}>
                                  <input type="checkbox" checked={checked} onChange={() => toggleChoice(q.id, opt)} className="accent-primary" />
                                  {opt}
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {(q.type === "text" || q.allow_custom) && (
                          <input
                            type="text"
                            value={a?.custom ?? ""}
                            onChange={(e) => setCustom(q.id, e.target.value)}
                            placeholder={q.type === "text" ? "Type your answer…" : "Other (custom answer)…"}
                            className="text-sm px-3 py-2 rounded-xl bg-card outline-none placeholder:text-muted-foreground"
                            style={{ border: `1.5px solid ${BLUE_BORDER}`, color: "var(--color-foreground)" }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* footer */}
          {phase !== "prd" && (phase === "form") && (
            <div className="flex-none px-7 py-5 bg-card border-t border-white/5 flex gap-3">
              <button
                onClick={handleGenerate}
                className="flex-1 py-3 rounded-xl text-sm font-medium transition-all hover:bg-muted text-muted-foreground bg-transparent border border-white/10"
              >
                Skip Questions
              </button>
              <button
                onClick={handleGenerate}
                disabled={!canGenerate && !noQuestions}
                className="flex-[2] py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 hover:opacity-85 text-primary-foreground flex items-center justify-center gap-1.5 bg-primary"
              >
                {canGenerate || noQuestions
                  ? <>Generate PRD <ChevronRight className="w-3.5 h-3.5" /></>
                  : `Answer all questions to continue  (${questions.length - answeredCount} remaining)`}
              </button>
            </div>
          )}
          {(phase === "researching" || phase === "generating") && (
            <div className="flex-none px-7 py-5 bg-card border-t border-white/5">
              <button disabled className="w-full py-3 rounded-xl text-sm font-semibold text-primary-foreground flex items-center justify-center gap-2" style={{ background: BLUE, opacity: 0.7 }}>
                <Loader2 className="w-4 h-4 animate-spin" /> {phase === "researching" ? "Researching…" : genStatus || "Generating…"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
