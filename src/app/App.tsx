import { memo, useState, useRef, useEffect } from "react";
import { ArrowUp, Sparkles, X, ChevronRight, Loader2, FileText, Menu, Plus, MessageSquare, Sun, Moon, Download, FileDown, Pencil, Eye, Bold, Italic, List, ListOrdered, Heading1, Heading2, Quote, Check, RefreshCw, Package } from "lucide-react";
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
  | "review"
  | "hub"
  | "failed";

interface DocEntry {
  id: string;
  title: string;
  markdown: string;
}

// The pipeline stages and the documents each produces (fixed structure per stage).
const STAGE_DOCS: Record<Stage, { id: string; title: string }[]> = {
  prd: [{ id: "prd", title: "PRD" }],
  design: [
    { id: "systemDesign", title: "System Design" },
    { id: "testSpec", title: "Test Specification" },
  ],
  backlog: [{ id: "backlog", title: "Sprint Backlog" }],
};

const STAGE_ORDER: Stage[] = ["prd", "design", "backlog"];

type Stage = "prd" | "design" | "backlog";

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
  docs?: DocEntry[];
  stage?: Stage;
  createdAt: string;
}

type LiveBlockStatus = "pending" | "generating" | "awaiting_approval" | "approved";

interface LiveBlock {
  id: string;
  title: string;
  status: LiveBlockStatus;
  message: string;
  content?: string;
  doc?: string;
}

const seed = (id: string, title: string): LiveBlock => ({
  id,
  title,
  status: "pending",
  message: "Queued",
});

// Pre-seeded live sections per stage (document order) so users see pending cards.
const STAGE_SEED: Record<Stage, LiveBlock[]> = {
  prd: [
    seed("prdPart1", "Overview — problem, users, goals & scope"),
    seed("useCases", "Research — Use cases & pain points"),
    seed("metrics", "Research — Metrics & benchmarks"),
    seed("scope", "Research — Scope & capabilities"),
    seed("compliance", "Research — Compliance & privacy"),
    seed("prdPart2", "Requirements & compliance"),
    seed("prdPart3", "Rollout, risks & acceptance criteria"),
  ],
  design: [
    seed("sd1", "System Design — Context, goals & architecture"),
    seed("sd2", "System Design — Interfaces, scaling, security & risks"),
    seed("ts1", "Test Spec — Scope, strategy & environments"),
    seed("ts2", "Test Spec — Test cases, criteria & traceability"),
  ],
  backlog: [
    seed("sb1", "Sprint Backlog — Sprint goal & backlog items"),
    seed("sb2", "Sprint Backlog — Epics, DoD & retrospective"),
  ],
};

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

function sanitizeFilenamePart(value: string) {
  return value
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function projectNameFromPrd(markdown: string, prompt: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const project = heading
    .replace(/\s+[\u2013\u2014-]\s+PRD\s*$/i, "")
    .replace(/\s+PRD\s*$/i, "")
    .trim();
  return sanitizeFilenamePart(project) || sanitizeFilenamePart(prompt) || "Project";
}

function dateFromPrd(markdown: string) {
  return markdown.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? new Date().toISOString().slice(0, 10);
}

function prdExportFilename(markdown: string, prompt: string, ext: "md" | "pdf") {
  const projectName = projectNameFromPrd(markdown, prompt);
  const date = dateFromPrd(markdown);
  return `${projectName}_PRD_${date}.${ext}`;
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
  
  // Basics only: intent, users, platforms, stage.
  const chips = [
    { label: "intent", values: str("intent") },
    { label: "users", values: arr("users") },
    { label: "platforms", values: arr("platforms") },
    { label: "stage", values: str("stage") },
  ].flatMap(c => c.values.map(v => ({ label: c.label, value: v })));

  return (
    <div className="rounded-2xl bg-card p-3 flex items-center gap-4 overflow-x-auto hide-scrollbar border-[1.5px] border-primary/20 shadow-md shadow-primary/10 text-white">
      <span className="text-[10px] uppercase tracking-widest font-bold whitespace-nowrap flex-none text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        Classification
      </span>
      {chips.length > 0 ? chips.map((c, i) => (
        <span key={i} className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap flex-none border border-white/25 bg-white/10 text-white">
          <span className="text-white/70 mr-1">{c.label}:</span>{humanize(c.value)}
        </span>
      )) : (
        <span className="text-[10px] text-white/70">Processing details...</span>
      )}
    </div>
  );
}

const STATUS_META: Record<LiveBlockStatus, { label: string; card: string; badge: string; dot: string }> = {
  pending: {
    label: "pending",
    card: "border-white/10 bg-white/[0.03]",
    badge: "border-white/15 bg-white/5 text-white/60",
    dot: "bg-white/40",
  },
  generating: {
    label: "generating",
    card: "border-sky-500/40 bg-sky-500/[0.06]",
    badge: "border-sky-500/40 bg-sky-500/15 text-sky-300",
    dot: "bg-sky-400",
  },
  awaiting_approval: {
    label: "awaiting approval",
    card: "border-amber-500/40 bg-amber-500/[0.06]",
    badge: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    dot: "bg-amber-400",
  },
  approved: {
    label: "approved",
    card: "border-emerald-500/40 bg-emerald-500/[0.06]",
    badge: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    dot: "bg-emerald-400",
  },
};

// The live document: each section is a color-coded card that streams its own
// content and transitions pending → generating → awaiting approval → approved.
function LiveDocumentState({ blocks }: { blocks: LiveBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="max-w-3xl mx-auto space-y-3">
      {blocks.map((block) => {
        const meta = STATUS_META[block.status];
        return (
          <div key={block.id} data-testid="section-card" data-section-id={block.id} data-status={block.status} className={`rounded-xl border px-4 py-3 transition-colors duration-300 ${meta.card}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full flex-none ${meta.dot} ${block.status === "generating" ? "animate-pulse" : ""}`} />
                <span className="text-xs font-semibold text-foreground truncate">{block.title}</span>
              </div>
              <span className={`text-[9px] uppercase tracking-widest font-bold flex-none px-2 py-0.5 rounded-full border ${meta.badge}`}>
                {meta.label}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1.5">
              {block.status === "generating" && <Loader2 className="w-3 h-3 animate-spin text-sky-400" />}
              <span className="truncate">{block.message}</span>
            </div>
            {block.content && (
              <div className="prd-doc mt-3 pt-3 border-t border-white/5 text-xs leading-relaxed text-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
              </div>
            )}
          </div>
        );
      })}
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
  // All choice questions are multi-select: answered when at least one box is
  // checked (or a custom answer is provided when allowed).
  return (a.choices?.length ?? 0) > 0 || (q.allow_custom && custom.length > 0);
}

function answerValue(q: Question, a: Answer): string | string[] {
  const custom = (a.custom ?? "").trim();
  if (q.type === "text") return custom;
  const vals = [...(a.choices ?? [])];
  if (custom) vals.push(custom);
  return vals;
}

function textContent(node: Node) {
  return (node.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u00a0/g, " ");
  if (!(node instanceof HTMLElement)) return "";

  const children = Array.from(node.childNodes).map(inlineMarkdown).join("");
  switch (node.tagName.toLowerCase()) {
    case "strong":
    case "b":
      return children.trim() ? `**${children.trim()}**` : "";
    case "em":
    case "i":
      return children.trim() ? `*${children.trim()}*` : "";
    case "code":
      return children.trim() ? `\`${children.trim()}\`` : "";
    case "a": {
      const href = node.getAttribute("href");
      return href && children.trim() ? `[${children.trim()}](${href})` : children;
    }
    case "br":
      return "\n";
    default:
      return children;
  }
}

function tableToMarkdown(table: HTMLTableElement) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) => inlineMarkdown(cell).replace(/\s+/g, " ").trim())
  ).filter((row) => row.length > 0);
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill("")]);
  const header = normalized[0];
  const body = normalized.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return textContent(node);
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  const childBlocks = () => Array.from(node.childNodes).map(blockMarkdown).filter(Boolean).join("\n\n");

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${inlineMarkdown(node).trim()}`;
  }
  if (tag === "p" || tag === "div") {
    return inlineMarkdown(node).trim() || childBlocks();
  }
  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    return Array.from(node.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((li, index) => {
        const marker = ordered ? `${index + 1}.` : "-";
        return `${marker} ${inlineMarkdown(li).trim()}`;
      })
      .join("\n");
  }
  if (tag === "blockquote") {
    return childBlocks().split("\n").map((line) => `> ${line}`).join("\n");
  }
  if (tag === "hr") return "---";
  if (tag === "table") return tableToMarkdown(node as HTMLTableElement);
  if (tag === "pre") return `\`\`\`\n${textContent(node)}\n\`\`\``;
  return childBlocks() || inlineMarkdown(node).trim();
}

function htmlToMarkdown(root: HTMLElement) {
  return Array.from(root.childNodes)
    .map(blockMarkdown)
    .filter(Boolean)
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

const EditablePrdEditor = memo(function EditablePrdEditor({
  markdown,
  onChange,
  editorKey,
}: {
  markdown: string;
  onChange: (next: string) => void;
  editorKey: number;
}) {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) onChange(htmlToMarkdown(editor));
  }, [editorKey]);

  const syncMarkdown = () => {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(htmlToMarkdown(editor));
  };

  const runCommand = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    syncMarkdown();
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-1.5 border border-primary/20 bg-card/95 backdrop-blur px-2 py-2 shadow-sm">
        <button type="button" className="editor-tool" title="Heading 1" onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "H1"); }}>
          <Heading1 className="w-4 h-4" />
        </button>
        <button type="button" className="editor-tool" title="Heading 2" onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "H2"); }}>
          <Heading2 className="w-4 h-4" />
        </button>
        <button type="button" className="editor-tool" title="Paragraph" onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "P"); }}>
          <span className="text-xs font-semibold">P</span>
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" className="editor-tool" title="Bold" onMouseDown={(e) => { e.preventDefault(); runCommand("bold"); }}>
          <Bold className="w-4 h-4" />
        </button>
        <button type="button" className="editor-tool" title="Italic" onMouseDown={(e) => { e.preventDefault(); runCommand("italic"); }}>
          <Italic className="w-4 h-4" />
        </button>
        <button type="button" className="editor-tool" title="Quote" onMouseDown={(e) => { e.preventDefault(); runCommand("formatBlock", "BLOCKQUOTE"); }}>
          <Quote className="w-4 h-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" className="editor-tool" title="Bulleted list" onMouseDown={(e) => { e.preventDefault(); runCommand("insertUnorderedList"); }}>
          <List className="w-4 h-4" />
        </button>
        <button type="button" className="editor-tool" title="Numbered list" onMouseDown={(e) => { e.preventDefault(); runCommand("insertOrderedList"); }}>
          <ListOrdered className="w-4 h-4" />
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={syncMarkdown}
        onBlur={syncMarkdown}
        className="prd-doc prd-editor text-sm leading-relaxed outline-none"
        style={{ color: "var(--color-foreground)" }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}, (prev, next) => prev.editorKey === next.editorKey);

export default function App() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("landing");
  const [submittedText, setSubmittedText] = useState("");
  const [classification, setClassification] = useState<Record<string, unknown> | null>(null);
  const [spec, setSpec] = useState<QuestionsSpec | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [prd, setPrd] = useState<string>("");
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [activeDocId, setActiveDocId] = useState<string>("prd");
  const [reviewComment, setReviewComment] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const [genStatus, setGenStatus] = useState("");
  const [liveBlocks, setLiveBlocks] = useState<LiveBlock[]>([]);
  const [isEditingPrd, setIsEditingPrd] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [editSaveStatus, setEditSaveStatus] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prdDocRef = useRef<HTMLDivElement>(null);
  const printPrdRef = useRef<HTMLDivElement>(null);

  const submitted = phase !== "landing";

  const patchLiveBlock = (id: string, patch: Partial<LiveBlock>) =>
    setLiveBlocks((prev) => {
      const i = prev.findIndex((b) => b.id === id);
      if (i === -1) {
        return [
          ...prev,
          { id, title: patch.title ?? id, status: patch.status ?? "pending", message: patch.message ?? "", content: patch.content, doc: patch.doc },
        ];
      }
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  const appendLiveBlockContent = (id: string, delta: string) =>
    setLiveBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, content: (b.content ?? "") + delta } : b)));

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
  const [stage, setStage] = useState<Stage>("prd");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);
  useEffect(() => {
    document.documentElement.dataset.stage = stage;
  }, [stage]);
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
      const restoredDocs: DocEntry[] =
        data.docs && data.docs.length ? data.docs : [{ id: "prd", title: "PRD", markdown: data.markdown }];
      const st: Stage = data.stage ?? "prd";
      const firstId = STAGE_DOCS[st]?.[0]?.id ?? restoredDocs[0].id;
      const active = restoredDocs.find((d) => d.id === firstId) ?? restoredDocs[0];
      setSubmittedText(data.prompt);
      setClassification(data.classification);
      setDocs(restoredDocs);
      setStage(st);
      setActiveDocId(active.id);
      setPrd(active.markdown);
      setNotes([]);
      setReviewComment("");
      setLiveBlocks([]);
      setIsEditingPrd(false);
      setEditorKey((value) => value + 1);
      setEditSaveStatus("Saved");
      setPhase("review");
      setPanelVisible(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  };

  useEffect(() => {
    if (phase !== "review" || !currentSessionId || !classification || !prd.trim()) return;
    setEditSaveStatus("Saving...");
    const timer = window.setTimeout(() => {
      try {
        const merged = docs.map((d) => (d.id === activeDocId ? { ...d, markdown: prd } : d));
        const prdDoc = merged.find((d) => d.id === "prd");
        const existing = readHistory().find((entry) => entry.id === currentSessionId);
        const nextHistory = saveHistoryItem({
          id: currentSessionId,
          prompt: submittedText,
          classification,
          markdown: prdDoc?.markdown ?? merged[0]?.markdown ?? prd,
          docs: merged,
          stage,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        });
        setHistoryList(nextHistory);
        setEditSaveStatus("Saved");
      } catch (e) {
        setEditSaveStatus(e instanceof Error ? e.message : "Save failed");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [phase, currentSessionId, classification, prd, submittedText, docs, activeDocId, stage]);

  const downloadBlob = (data: BlobPart, mime: string, filename: string) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadMarkdown = () => {
    if (!prd.trim()) return;
    downloadBlob(prd, "text/markdown;charset=utf-8", prdExportFilename(prd, submittedText, "md"));
  };

  const docFilename = (doc: DocEntry, ext: "md") => {
    const project = sanitizeFilenamePart(submittedText) || "Project";
    return `${project}_${sanitizeFilenamePart(doc.title)}.${ext}`;
  };

  const downloadDocMarkdown = (doc: DocEntry) =>
    downloadBlob(doc.markdown, "text/markdown;charset=utf-8", docFilename(doc, "md"));

  const downloadAllZip = async () => {
    if (docs.length === 0) return;
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const doc of docs) zip.file(docFilename(doc, "md"), doc.markdown);
    const blob = await zip.generateAsync({ type: "blob" });
    const project = sanitizeFilenamePart(submittedText) || "Project";
    downloadBlob(blob, "application/zip", `${project}_documents.zip`);
  };

  const exportPdf = () => {
    if (!prd.trim()) return;
    const html = printPrdRef.current?.innerHTML || `<pre>${escapeHtml(prd)}</pre>`;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("PDF export blocked by popup settings");
      return;
    }
    const filename = prdExportFilename(prd, submittedText, "pdf");
    printWindow.document.write(`<!doctype html>
<html>
<head>
  <title>${escapeHtml(filename)}</title>
  <style>
    @page { size: Letter; margin: 0.65in; }
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; margin: 0; line-height: 1.45; font-size: 11px; }
    h1 { font-size: 24px; margin: 0 0 14px; break-after: avoid; page-break-after: avoid; }
    h1:not(:first-of-type) { break-before: page; page-break-before: always; }
    h2 { font-size: 17px; margin: 20px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; break-after: avoid; page-break-after: avoid; }
    h3 { font-size: 13px; margin: 14px 0 6px; break-after: avoid; page-break-after: avoid; }
    p, li, blockquote, pre { break-inside: avoid; page-break-inside: avoid; orphans: 3; widows: 3; }
    ul, ol { break-inside: avoid; page-break-inside: avoid; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; font-size: 8px; break-inside: avoid; page-break-inside: avoid; }
    thead, tbody, tr, th, td { break-inside: avoid; page-break-inside: avoid; }
    th, td { border: 1px solid #d1d5db; padding: 3px 4px; vertical-align: top; }
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

  


  // ── Generic SSE stream reader ──────────────────────────────────────────────
  // Drives the live section cards and collects the finalized documents (one per
  // `replace` event, tagged by docId). Returns the collected docs in arrival order.
  const runStream = async (endpoint: string, body: unknown): Promise<DocEntry[]> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({ error: "Stream failed" }));
      throw new Error(errData.error || "Stream failed");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError: string | null = null;
    const collected: DocEntry[] = [];
    const upsertDoc = (d: DocEntry) => {
      const i = collected.findIndex((x) => x.id === d.id);
      if (i === -1) collected.push(d);
      else collected[i] = d;
    };
    const handleStreamMessage = (msg: string) => {
      if (!msg.trim()) return;
      let event = "";
      let data = "";
      for (const line of msg.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!event || !data) throw new Error(`Malformed stream event: ${msg}`);
      const parsed = JSON.parse(data);
      switch (event) {
        case "status":
          setGenStatus(parsed.message || "");
          if (parsed.phase === "researching") setPhase("researching");
          else if (parsed.phase === "generating") setPhase("generating");
          break;
        case "section":
          if (typeof parsed.id !== "string") throw new Error(`Malformed section event: ${msg}`);
          patchLiveBlock(parsed.id, { title: parsed.title, status: parsed.status, message: parsed.message, doc: parsed.doc });
          setGenStatus(parsed.message || "");
          break;
        case "section_delta":
          if (typeof parsed.id !== "string" || typeof parsed.delta !== "string") throw new Error(`Malformed section_delta event: ${msg}`);
          appendLiveBlockContent(parsed.id, parsed.delta);
          break;
        case "section_content":
          if (typeof parsed.id !== "string" || typeof parsed.content !== "string") throw new Error(`Malformed section_content event: ${msg}`);
          patchLiveBlock(parsed.id, { content: parsed.content });
          break;
        case "replace":
          if (typeof parsed.content !== "string" || typeof parsed.docId !== "string") throw new Error(`Malformed replace event: ${msg}`);
          upsertDoc({ id: parsed.docId, title: parsed.title || parsed.docId, markdown: parsed.content });
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
      for (const msg of messages) handleStreamMessage(msg);
    }
    if (buffer.trim()) handleStreamMessage(buffer);
    if (streamError) throw new Error(streamError);
    return collected;
  };

  const persistSession = (allDocs: DocEntry[], atStage: Stage) => {
    if (!classification) return;
    const id = currentSessionId ?? crypto.randomUUID();
    const prdDoc = allDocs.find((d) => d.id === "prd");
    const existing = readHistory().find((entry) => entry.id === id);
    const nextHistory = saveHistoryItem({
      id,
      prompt: submittedText,
      classification,
      markdown: prdDoc?.markdown ?? allDocs[0]?.markdown ?? "",
      docs: allDocs,
      stage: atStage,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    setCurrentSessionId(id);
    setHistoryList(nextHistory);
    setEditSaveStatus("Saved");
  };

  // ── Stage generation ────────────────────────────────────────────────────────
  const startGeneration = async (targetStage: Stage, endpoint: string, body: unknown) => {
    setError(null);
    setStage(targetStage);
    setLiveBlocks(STAGE_SEED[targetStage]);
    setGenStatus("Starting…");
    setIsEditingPrd(false);
    setReviewComment("");
    setEditorKey((v) => v + 1);
    setEditSaveStatus("");
    setPhase(targetStage === "prd" ? "researching" : "generating");
    const priorDocs = docs;
    try {
      const collected = await runStream(endpoint, body);
      if (collected.length === 0) throw new Error("No document was produced");
      const map = new Map(priorDocs.map((d) => [d.id, d]));
      for (const d of collected) map.set(d.id, d);
      const merged = Array.from(map.values());
      const firstId = STAGE_DOCS[targetStage][0].id;
      const first = collected.find((d) => d.id === firstId) ?? collected[0];
      setDocs(merged);
      setActiveDocId(first.id);
      setPrd(first.markdown);
      setEditorKey((v) => v + 1);
      setPhase("review");
      persistSession(merged, targetStage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(targetStage === "prd" && spec ? "form" : "failed");
    }
  };

  const buildAnswersPayload = () => {
    const payload: Record<string, string | string[]> = {};
    for (const q of spec?.questions ?? []) {
      const a = answers[q.id];
      if (a) payload[q.label] = answerValue(q, a);
    }
    return payload;
  };

  const triggerGeneratePrd = (
    promptToUse: string,
    clsToUse: Record<string, unknown>,
    payload: Record<string, string | string[]>,
    extraNotes: string[] = []
  ) => {
    setPrd("");
    setDocs([]);
    startGeneration("prd", "/api/generate-prd", {
      prompt: promptToUse,
      classification: clsToUse,
      answers: payload,
      notes: extraNotes,
    });
  };

  // Prefer the live editable buffer for the active doc so unsaved edits flow
  // into downstream stages' grounding.
  const docMarkdown = (id: string) => (id === activeDocId ? prd : docs.find((d) => d.id === id)?.markdown ?? "");

  const triggerDesign = (extraNotes: string[] = []) =>
    startGeneration("design", "/api/generate-design", {
      prompt: submittedText,
      classification,
      prd: docMarkdown("prd"),
      notes: extraNotes,
    });

  const triggerBacklog = (extraNotes: string[] = []) =>
    startGeneration("backlog", "/api/generate-backlog", {
      prompt: submittedText,
      classification,
      prd: docMarkdown("prd"),
      systemDesign: docMarkdown("systemDesign"),
      testSpec: docMarkdown("testSpec"),
      notes: extraNotes,
    });

  // ── Review gate: tabs, approve/deny, comment-driven revision ─────────────────
  const commitActiveDoc = () =>
    setDocs((prev) => prev.map((d) => (d.id === activeDocId ? { ...d, markdown: prd } : d)));

  const selectDoc = (id: string) => {
    if (id === activeDocId) return;
    commitActiveDoc();
    const target = docs.find((d) => d.id === id);
    setActiveDocId(id);
    setPrd(target?.markdown ?? "");
    setIsEditingPrd(false);
    setEditorKey((v) => v + 1);
  };

  const approveStage = () => {
    commitActiveDoc();
    setNotes([]);
    setReviewComment("");
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
    if (next === "design") triggerDesign();
    else if (next === "backlog") triggerBacklog();
    else setPhase("hub"); // backlog approved → download hub
  };

  const submitRevision = (text: string) => {
    if (phase !== "review") return;
    const note = text.trim();
    const nextNotes = note ? [...notes, note] : notes;
    setNotes(nextNotes);
    setReviewComment("");
    if (stage === "prd") triggerGeneratePrd(submittedText, classification!, buildAnswersPayload(), nextNotes);
    else if (stage === "design") triggerDesign(nextNotes);
    else if (stage === "backlog") triggerBacklog(nextNotes);
  };

  const handleGenerate = () => {
    if (!classification) return;
    triggerGeneratePrd(submittedText, classification, buildAnswersPayload());
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
      setStage("prd");
      setSubmittedText("");
      setClassification(null);
      setSpec(null);
      setAnswers({});
      setPrd("");
      setDocs([]);
      setActiveDocId("prd");
      setNotes([]);
      setReviewComment("");
      setLiveBlocks([]);
      setError(null);
      setInput("");
      setGenStatus("");
      setIsEditingPrd(false);
      setEditorKey((value) => value + 1);
      setEditSaveStatus("");
    }, 300);
  };

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

  const STAGE_LABEL: Record<Stage, string> = {
    prd: "Product Requirements",
    design: "System Design & Test Spec",
    backlog: "Sprint Backlog",
  };
  const stageDocList = STAGE_DOCS[stage];
  const isReview = phase === "review";
  const isGenerating = phase === "generating" || phase === "researching";
  const activeDocTitle = docs.find((d) => d.id === activeDocId)?.title ?? stageDocList[0]?.title ?? "Document";
  const isLastStage = STAGE_ORDER.indexOf(stage) === STAGE_ORDER.length - 1;
  const submitLeftChat = () => {
    const text = chatInput.trim();
    if (!text || !isReview) return;
    setChatInput("");
    submitRevision(text);
  };

  const statusLine = () => {
    switch (phase) {
      case "classifying":
        return "Classifying your requirement…";
      case "questioning":
        return "Working out what I still need to know…";
      case "researching":
        return genStatus || "Researching real-world context…";
      case "generating":
        return genStatus || `Working on ${STAGE_LABEL[stage]}…`;
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

        {/* HUB — all documents, download individually or as a zip */}
        {phase === "hub" && (
          <div data-testid="hub" className="absolute inset-0 z-30 bg-background flex flex-col overflow-hidden">
            <div className="flex-none flex items-center justify-between px-8 py-5 border-b border-white/10 bg-card">
              <div>
                <div className="text-[10px] uppercase tracking-widest mb-1 font-bold text-primary" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  Delivery
                </div>
                <div className="text-base font-bold text-foreground">All documents ready</div>
              </div>
              <div className="flex items-center gap-3">
                <button data-testid="zip-btn" onClick={downloadAllZip} className="h-9 px-4 rounded-lg flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground hover:opacity-85 transition-all">
                  <Package className="w-4 h-4" /> Download all (.zip)
                </button>
                <button onClick={handleNewChat} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-none flex items-center gap-2 px-8 pt-4 border-b border-white/10 bg-card overflow-x-auto hide-scrollbar">
              {docs.map((d) => (
                <button
                  key={d.id}
                  data-testid="hub-tab"
                  onClick={() => setActiveDocId(d.id)}
                  className={`px-4 py-2 text-xs font-semibold -mb-px border-b-2 whitespace-nowrap transition-colors ${activeDocId === d.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {d.title}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-10 py-8">
              <div className="max-w-3xl mx-auto mb-4 flex justify-end">
                {docs.find((d) => d.id === activeDocId) && (
                  <button onClick={() => downloadDocMarkdown(docs.find((d) => d.id === activeDocId)!)} className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-xs font-medium border border-white/10 hover:bg-muted text-muted-foreground hover:text-foreground">
                    <Download className="w-3.5 h-3.5" /> Download .md
                  </button>
                )}
              </div>
              <div className="prd-doc max-w-3xl mx-auto text-sm leading-relaxed" style={{ color: "var(--color-foreground)" }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{docs.find((d) => d.id === activeDocId)?.markdown ?? ""}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}

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

                {isReview && (
                  <div className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex-none flex items-center justify-center mt-0.5 shadow-sm bg-primary">
                      <Sparkles className="w-3.5 h-3.5 text-primary-foreground" />
                    </div>
                    <div className="px-4 py-3 rounded-2xl rounded-tl-sm text-sm leading-relaxed bg-card" style={{ border: `1.5px solid ${BLUE_BORDER}`, boxShadow: "0 2px 8px color-mix(in srgb, var(--color-primary) 8%, transparent)" }}>
                      <span className="text-foreground font-semibold">Done.</span>
                      <span className="text-muted-foreground"> Your {STAGE_LABEL[stage].toLowerCase()} {stageDocList.length > 1 ? "documents are" : "document is"} on the right. Approve to continue, or tell me what to change.</span>
                    </div>
                  </div>
                )}
                {notes.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {notes.map((n, i) => (
                      <div key={i} className="flex justify-end">
                        <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-sm text-sm leading-relaxed bg-[#1e1f20] text-foreground">
                          <span className="text-[10px] uppercase tracking-wide text-primary font-bold mr-1">revision</span>{n}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-none px-7 py-4 bg-card border-t border-white/5">
                <div className="flex items-center gap-3 rounded-xl bg-background px-4 py-2.5 border border-primary/30">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitLeftChat(); } }}
                    disabled={!isReview}
                    placeholder={isReview ? "Ask for a change or refinement…" : "Add more context or ask a question…"}
                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-60"
                  />
                  <button onClick={submitLeftChat} disabled={!isReview || !chatInput.trim()} className="w-7 h-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-40 hover:opacity-85 bg-primary">
                    <ArrowUp className="w-3.5 h-3.5 text-primary-foreground" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — form / PRD panel */}
        <div className="flex-none flex flex-col overflow-hidden transition-all duration-300 ease-in-out" style={{ width: panelVisible ? "54%" : "0%", opacity: panelVisible ? 1 : 0, borderLeft: `2px solid color-mix(in srgb, var(--color-primary) 28%, transparent)`, background: (isReview || phase === "generating") ? "var(--color-card)" : "var(--color-secondary)" }}>
          {/* header */}
          <div className="flex-none flex items-center justify-between px-7 py-5 bg-card" style={{ borderBottom: `2px solid color-mix(in srgb, var(--color-primary) 18%, transparent)` }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest mb-1 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: BLUE }}>
                {isReview || phase === "generating" ? STAGE_LABEL[stage] : phase === "researching" ? "Research" : "Scoping Questions"}
              </div>
              <div className="text-sm font-bold text-foreground">
                {isReview ? `${isEditingPrd ? "Editing" : "Reviewing"} ${activeDocTitle}${editSaveStatus ? ` · ${editSaveStatus}` : ""}` : phase === "generating" ? genStatus || "Writing…" : phase === "researching" ? genStatus || "Researching…" : "Just a few questions to clarify requirement"}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {isReview && prd.trim() && (
                <>
                  <button
                    onClick={() => {
                      setIsEditingPrd((value) => {
                        const next = !value;
                        if (next) setEditorKey((key) => key + 1);
                        return next;
                      });
                    }}
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
              {!isReview && questions.length > 0 && (
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
          {phase === "generating" || phase === "researching" ? (
            <div className="flex-1 overflow-y-auto px-10 py-8">
              <div className="max-w-3xl mx-auto mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span className="truncate">{genStatus || "Working…"}</span>
              </div>
              <LiveDocumentState blocks={liveBlocks} />
            </div>
          ) : isReview ? (
            <div className="flex-1 overflow-y-auto px-10 py-8">
              {stageDocList.length > 1 && (
                <div className="max-w-3xl mx-auto mb-5 flex items-center gap-2 border-b border-white/10">
                  {stageDocList.map((d) => (
                    <button
                      key={d.id}
                      data-testid="doc-tab"
                      data-doc-id={d.id}
                      onClick={() => selectDoc(d.id)}
                      className={`px-4 py-2 text-xs font-semibold -mb-px border-b-2 transition-colors ${activeDocId === d.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                      {d.title}
                    </button>
                  ))}
                </div>
              )}
              {isEditingPrd ? (
                <EditablePrdEditor
                  key={editorKey}
                  editorKey={editorKey}
                  markdown={prd}
                  onChange={setPrd}
                />
              ) : (
                <div ref={prdDocRef} data-testid="prd-doc" className="prd-doc max-w-3xl mx-auto text-sm leading-relaxed" style={{ color: "var(--color-foreground)" }}>
                  {prd ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd}</ReactMarkdown>
                  ) : (
                    <div className="border border-dashed border-primary/25 bg-background/60 px-5 py-8 text-center text-sm text-muted-foreground">
                      No content
                    </div>
                  )}
                </div>
              )}
              <div ref={printPrdRef} className="prd-doc hidden">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd}</ReactMarkdown>
              </div>
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
                    <div key={q.id} data-testid="question-card" data-answered={done} className="rounded-2xl bg-card p-5 transition-shadow" style={{ border: done ? `2px solid ${BLUE}` : `1.5px solid color-mix(in srgb, var(--color-primary) 22%, transparent)`, boxShadow: "0 2px 10px color-mix(in srgb, var(--color-primary) 9%, transparent)" }}>
                      <div className="flex items-start gap-3 mb-1">
                        <span className="w-5 h-5 rounded-full flex-none flex items-center justify-center text-[10px] font-bold mt-0.5" style={{ background: done ? BLUE : BLUE_LIGHT, color: done ? "#ffffff" : BLUE, fontFamily: "'JetBrains Mono', monospace" }}>
                          {done ? "✓" : i + 1}
                        </span>
                        <p className="text-sm font-medium text-foreground leading-snug">{q.label}</p>
                      </div>
                      {q.help && <p className="text-xs ml-8 mb-3 text-muted-foreground">{q.help}</p>}

                      <div className="ml-8 mt-3 flex flex-col gap-2">
                        {(q.type === "single_select" || q.type === "multi_select") && (
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
          {phase === "form" && (
            <div className="flex-none px-7 py-5 bg-card border-t border-white/5 flex gap-3">
              <button
                onClick={handleGenerate}
                className="flex-1 py-3 rounded-xl text-sm font-medium transition-all hover:bg-muted text-muted-foreground bg-transparent border border-white/10"
              >
                Skip Questions
              </button>
              <button
                onClick={handleGenerate}
                data-testid="generate-btn"
                disabled={!canGenerate && !noQuestions}
                className="flex-[2] py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 hover:opacity-85 text-primary-foreground flex items-center justify-center gap-1.5 bg-primary"
              >
                {canGenerate || noQuestions
                  ? <>Generate PRD <ChevronRight className="w-3.5 h-3.5" /></>
                  : `Answer all questions to continue  (${questions.length - answeredCount} remaining)`}
              </button>
            </div>
          )}
          {isGenerating && (
            <div className="flex-none px-7 py-5 bg-card border-t border-white/5">
              <button disabled className="w-full py-3 rounded-xl text-sm font-semibold text-primary-foreground flex items-center justify-center gap-2" style={{ background: BLUE, opacity: 0.7 }}>
                <Loader2 className="w-4 h-4 animate-spin" /> {genStatus || (phase === "researching" ? "Researching…" : "Generating…")}
              </button>
            </div>
          )}
          {isReview && (
            <div className="flex-none px-7 py-4 bg-card border-t border-white/5 flex flex-col gap-2.5">
              <textarea
                value={reviewComment}
                onChange={(e) => setReviewComment(e.target.value)}
                rows={2}
                placeholder={`Comment to revise this ${activeDocTitle.toLowerCase()} — the AI rectifies and regenerates…`}
                className="w-full bg-background text-sm text-foreground placeholder:text-muted-foreground px-3 py-2 rounded-xl border border-primary/30 outline-none resize-none"
              />
              <div className="flex gap-3">
                <button
                  data-testid="deny-btn"
                  onClick={() => submitRevision(reviewComment)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all hover:bg-muted text-muted-foreground bg-transparent border border-white/10 flex items-center justify-center gap-1.5"
                  title="Reject and regenerate with your comments"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Deny &amp; revise
                </button>
                <button
                  data-testid="approve-btn"
                  onClick={approveStage}
                  className="flex-[2] py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-85 text-primary-foreground flex items-center justify-center gap-1.5 bg-primary"
                >
                  <Check className="w-3.5 h-3.5" />
                  {isLastStage ? "Approve & finish" : `Approve → ${STAGE_LABEL[STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1]]}`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
