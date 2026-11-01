#!/usr/bin/env bun
// records.ts — query Work/records/*.toml (strict subset, zero deps).
// Usage: bun records.ts check | plan | needs | tasks | decisions | concepts [--status X] [--repo Y] [--tsv]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, string | string[]>;
const s = (r: Rec, k: string): string => String(r[k] ?? "");
const arr = (r: Rec, k: string): string[] => (Array.isArray(r[k]) ? (r[k] as string[]) : []);

function parseVal(v: string, src: string): string | string[] {
  v = v.trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (!m) throw new Error(`${src}: bad string: ${v}`);
    return m[1].replace(/\\(.)/g, "$1");
  }
  if (v.startsWith("[")) {
    const m = v.match(/^\[(.*)\]$/);
    if (!m) throw new Error(`${src}: bad array: ${v}`);
    const inner = m[1].trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => {
      const t = item.trim();
      const sm = t.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (!sm) throw new Error(`${src}: bad array item: ${item}`);
      return sm[1].replace(/\\(.)/g, "$1");
    });
  }
  throw new Error(`${src}: bad value (want string or array): ${v}`);
}

function parseFile(name: string, table: string, required: string[]): Rec[] {
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  for (const raw of readFileSync(join(DIR, name), "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const mt = line.match(/^\[\[(\w+)\]\]$/);
    if (mt) {
      if (mt[1] !== table) throw new Error(`${name}: unexpected [[${mt[1]}]]`);
      cur = {};
      recs.push(cur);
      continue;
    }
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!m || !cur) throw new Error(`${name}: bad line: ${raw}`);
    cur[m[1]] = parseVal(m[2], name);
  }
  for (const r of recs)
    for (const k of required)
      if (!(k in r)) throw new Error(`${name}: record ${s(r, "id") || "?"} missing ${k}`);
  return recs;
}

const NEEDS = () =>
  parseFile("needs.toml", "need", ["id", "repo", "title", "status", "detail", "evidence", "blocked_by", "agent", "updated"]);
const TASKS = () =>
  parseFile("tasks.toml", "task", ["id", "title", "status", "detail", "evidence", "blocked_by", "agent", "updated"]);
const DECS = () =>
  parseFile("decisions.toml", "decision", ["id", "title", "status", "detail", "decided", "outcome"]);
const CONCEPTS = () =>
  parseFile("concepts.toml", "concept", ["id", "title", "status", "statement", "source", "informs", "updated"]);

const NEED_STATUS = ["needed", "active", "landed", "blocked", "dropped"];
const TASK_STATUS = ["needed", "active", "done", "blocked", "dropped"];
const DEC_STATUS = ["open", "decided"];
const CONCEPT_STATUS = ["adopted", "proposed", "retired"];
const REPOS = ["centrs", "quickchr", "rosetta", "shared"];

function check(): string[] {
  const errs: string[] = [];
  let needs: Rec[] = [];
  let tasks: Rec[] = [];
  let decs: Rec[] = [];
  let concepts: Rec[] = [];
  try {
    needs = NEEDS();
  } catch (e) {
    errs.push(String(e));
  }
  try {
    tasks = TASKS();
  } catch (e) {
    errs.push(String(e));
  }
  try {
    decs = DECS();
  } catch (e) {
    errs.push(String(e));
  }
  try {
    concepts = CONCEPTS();
  } catch (e) {
    errs.push(String(e));
  }
  const ids = new Set([...needs, ...tasks, ...decs, ...concepts].map((r) => s(r, "id")));
  const uniq = (rs: Rec[], f: string) => {
    const seen = new Set<string>();
    for (const r of rs) {
      if (seen.has(s(r, "id"))) errs.push(`${f}: duplicate id ${s(r, "id")}`);
      seen.add(s(r, "id"));
    }
  };
  uniq(needs, "needs.toml");
  uniq(tasks, "tasks.toml");
  uniq(decs, "decisions.toml");
  uniq(concepts, "concepts.toml");
  for (const r of needs) {
    if (!NEED_STATUS.includes(s(r, "status"))) errs.push(`needs: ${s(r, "id")} bad status ${s(r, "status")}`);
    if (!REPOS.includes(s(r, "repo"))) errs.push(`needs: ${s(r, "id")} bad repo ${s(r, "repo")}`);
  }
  for (const r of tasks)
    if (!TASK_STATUS.includes(s(r, "status"))) errs.push(`tasks: ${s(r, "id")} bad status ${s(r, "status")}`);
  for (const r of decs)
    if (!DEC_STATUS.includes(s(r, "status"))) errs.push(`decisions: ${s(r, "id")} bad status ${s(r, "status")}`);
  for (const r of concepts)
    if (!CONCEPT_STATUS.includes(s(r, "status"))) errs.push(`concepts: ${s(r, "id")} bad status ${s(r, "status")}`);
  for (const r of [...needs, ...tasks])
    for (const d of arr(r, "blocked_by")) {
      if (d === s(r, "id")) errs.push(`${s(r, "id")}: self-dependency`);
      else if (!ids.has(d)) errs.push(`${s(r, "id")}: unknown blocked_by ${d}`);
    }
  for (const r of concepts)
    for (const d of arr(r, "informs")) {
      if (!ids.has(d)) errs.push(`${s(r, "id")}: unknown informs ${d}`);
    }
  return errs;
}

function loadAll(): { needs: Rec[]; tasks: Rec[]; decs: Rec[]; concepts: Rec[] } {
  return { needs: NEEDS(), tasks: TASKS(), decs: DECS(), concepts: CONCEPTS() };
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function printNeeds(args: string[]): void {
  const { needs } = loadAll();
  const st = flag(args, "--status");
  const repo = flag(args, "--repo");
  const tsv = args.includes("--tsv");
  const rows = needs.filter((r) => (!st || s(r, "status") === st) && (!repo || s(r, "repo") === repo));
  for (const r of rows) {
    if (tsv) console.log([s(r, "id"), s(r, "repo"), s(r, "status"), s(r, "title"), arr(r, "blocked_by").join(",")].join("\t"));
    else console.log(`${s(r, "id")} [${s(r, "repo")}/${s(r, "status")}] ${s(r, "title")}${arr(r, "blocked_by").length ? ` (waits on ${arr(r, "blocked_by").join(",")})` : ""}`);
  }
}

function printTasks(args: string[]): void {
  const { tasks } = loadAll();
  const st = flag(args, "--status");
  const tsv = args.includes("--tsv");
  const rows = tasks.filter((r) => !st || s(r, "status") === st);
  for (const r of rows) {
    if (tsv) console.log([s(r, "id"), s(r, "status"), s(r, "title"), arr(r, "blocked_by").join(",")].join("\t"));
    else console.log(`${s(r, "id")} [${s(r, "status")}] ${s(r, "title")}${arr(r, "blocked_by").length ? ` (waits on ${arr(r, "blocked_by").join(",")})` : ""}`);
  }
}

function printDecs(args: string[]): void {
  const { decs } = loadAll();
  const st = flag(args, "--status");
  for (const r of decs.filter((d) => !st || s(d, "status") === st))
    console.log(`${s(r, "id")} [${s(r, "status")}] ${s(r, "title")}${s(r, "status") === "decided" ? ` — ${s(r, "outcome")}` : ` — ${s(r, "detail")}`}`);
}

function printConcepts(args: string[]): void {
  const { concepts } = loadAll();
  const st = flag(args, "--status");
  const tsv = args.includes("--tsv");
  const rows = concepts.filter((r) => !st || s(r, "status") === st);
  for (const r of rows) {
    if (tsv) console.log([s(r, "id"), s(r, "status"), s(r, "title"), arr(r, "informs").join(",")].join("\t"));
    else console.log(`${s(r, "id")} [${s(r, "status")}] ${s(r, "title")} (informs ${arr(r, "informs").join(",") || "—"})`);
  }
}

function plan(): void {
  const { tasks, decs } = loadAll();
  const dstat = new Map(decs.map((d) => [s(d, "id"), s(d, "status")]));
  const tstat = new Map(tasks.map((t) => [s(t, "id"), s(t, "status")]));
  const gateDone = (g: string): boolean =>
    (g.startsWith("D") && dstat.get(g) === "decided") || (g.startsWith("T") && tstat.get(g) === "done");
  console.log("== open decisions (unblock the plan) ==");
  for (const d of decs.filter((x) => s(x, "status") === "open")) console.log(`  ${s(d, "id")}: ${s(d, "title")}`);
  // Kahn topo over task->task edges; decisions are gates, not nodes.
  const open = tasks.filter((t) => s(t, "status") !== "done" && s(t, "status") !== "dropped");
  const ids = new Set(open.map((t) => s(t, "id")));
  const indeg = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const t of open) {
    indeg.set(s(t, "id"), 0);
    next.set(s(t, "id"), []);
  }
  for (const t of open)
    for (const g of arr(t, "blocked_by")) {
      if (!g.startsWith("T") || !ids.has(g)) continue;
      next.get(g)!.push(s(t, "id"));
      indeg.set(s(t, "id"), (indeg.get(s(t, "id")) ?? 0) + 1);
    }
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const m of next.get(id) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 1) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  for (const t of open) if (!order.includes(s(t, "id"))) order.push(s(t, "id")); // cycle fallback: append
  const byId = new Map(open.map((t) => [s(t, "id"), t]));
  console.log("== tasks in dependency order ==");
  for (const id of order) {
    const t = byId.get(id)!;
    const gates = arr(t, "blocked_by");
    const waiting = gates.filter((g) => !gateDone(g));
    let mark: string;
    if (s(t, "status") === "blocked" && gates.length === 0) mark = "WAIT external";
    else if (s(t, "status") === "blocked" && waiting.length === 0) mark = "WAIT stale-flag";
    else if (waiting.length === 0) mark = "READY";
    else mark = `WAIT ${waiting.join(",")}`;
    console.log(`  [${mark}] ${id}: ${s(t, "title")}`);
  }
}

const [cmd, ...rest] = Bun.argv.slice(2);
if (cmd === "check") {
  const errs = check();
  if (errs.length) {
    for (const e of errs) console.error(e);
    process.exit(1);
  }
  const { needs, tasks, decs, concepts } = loadAll();
  console.log(`ok: ${needs.length} needs, ${tasks.length} tasks, ${decs.length} decisions, ${concepts.length} concepts`);
} else if (cmd === "needs") printNeeds(rest);
else if (cmd === "tasks") printTasks(rest);
else if (cmd === "decisions") printDecs(rest);
else if (cmd === "concepts") printConcepts(rest);
else if (cmd === "plan") plan();
else {
  console.error("usage: records.ts check | plan | needs | tasks | decisions | concepts [--status X] [--repo Y] [--tsv]");
  process.exit(2);
}
