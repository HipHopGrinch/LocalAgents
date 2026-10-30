# LocalAgents Studio - Project History & Technical Overview

## 1. Project Background & Motivation
**LocalAgents Studio** was created to bridge a critical capability gap in modern AI coding environments: tools like Google Antigravity and Cursor rely heavily on cloud-hosted frontier LLMs and lack first-class native multi-agent execution targeting locally hosted Ollama/vLLM endpoints across a local hardware cluster.

Designed for mixed local hardware clusters, for example:
- **High-end gaming PC:** 16–24 GB VRAM (RTX 4080 / 4090 class)
- **Mid-range desktop:** 8–12 GB VRAM (RTX 3060 12GB / 4070 class)
- **Budget / thin laptop:** ~6 GB VRAM (RTX 3060 Laptop class)
- **Frontier APIs (optional):** Grok / OpenAI when cloud reasoning is explicitly required.

The core goal of LocalAgents Studio is to eliminate costly API token consumption by maximizing local hardware utilization, parallelizing code generation tasks across multiple physical GPU nodes simultaneously, and providing a standalone desktop IDE (built on Electron, React 19, Vite, TailwindCSS, and Monaco Editor) with direct filesystem execution capabilities.

---

## 2. Architecture & Design Principles

### A. Electron & React Dual-Process Architecture
- **Main Process (`electron/main.cjs`):**
  - Manages native OS operations, Electron BrowserWindow lifecycle, and IPC handlers.
  - Safe filesystem access for the explorer (`readFile`, `writeFile`, `createFile`, `createFolder`, `deleteTarget`, `readDir`).
  - Agent tools are **workspace-scoped** via `tools:exec` (`resolveScoped`) so relative agent paths cannot escape the open folder.
  - PowerShell child-process execution with streaming output to the Terminal panel (`TerminalPanel.tsx` — command runner, not a full PTY/xterm session).
  - Cluster status polling (`clusterStatus`) measuring ping latency, active models, and loaded VRAM models across all configured LAN endpoints.
  - Remote model pull commands (`ollama pull <model>`) via streaming HTTP endpoints on remote nodes.
  - Automated benchmark engine (`ollama:benchmark`) measuring generation speed (`evalTokPerSec`), prompt processing speed (`promptTokPerSec`), and model load times using a short coding generate prompt (`num_predict: 64`).
- **Renderer Process (`src/`):**
  - React 19 + TypeScript + Vite.
  - Monaco Editor integration for syntax-highlighted multi-tab code editing.
  - Resizable split pane layout (File Explorer, Monaco Editor + Terminal, Agent Conductor sidebar).

### B. Settings & secrets
- Settings (including optional Frontier API keys) persist to Electron `userData/settings.json` in **plaintext** on the local machine. Keys are not encrypted and must not be committed or logged.

---

## 3. Major Evolution & Milestones

### Phase 1: Foundations & Cluster Connectivity
- Configured multi-node cluster defaults (local Ollama + LAN peers + optional frontier API) with DNS aliases and live status polling.
- Built cluster polling logic to detect node online status, ping latency, and running models in real time (merges status without wiping user model toggles / benchmarks).
- Integrated multi-tab Monaco editor with dirty-state tracking, language detection, and file tree operations.

### Phase 2: Hardware Configuration & Real-Time Benchmarking
- Added the **Cluster & Hardware Settings** modal (`HardwareSettingsModal.tsx` + `hardware/*` panels):
  - Hardware specification inputs (CPU, GPU, VRAM, RAM, memory bandwidth).
  - VRAM estimation calculator computing parameter size, context window memory (`f16`/`q8`/`q4`), and max KV cache limits.
  - Automated Token/sec benchmark runner; seeded default speeds are marked `provisional: true` until a live benchmark succeeds.
  - Catalog of recommended models based on hardware specs.
  - Filtering out non-generative embedding models from code generation dropdowns and benchmarks.
  - Remote model pull trigger enabling remote endpoints to pull new models from Ollama without needing SSH.

### Phase 3: File System Tooling & Autonomous Execution
- Designed and implemented the **Autonomous Tool Protocol** (`tools.ts` + `agentLoop.ts`):
  - `<write_file path="...">` for direct full-file creation.
  - `<edit_file path="...">` with unified SEARCH/REPLACE diff matching and fuzzy indentation handling.
  - `<read_file>`, `<list_dir>`, `<search>`, and `<run_command>` (PowerShell; stdout returned to the agent).
  - **Tool Result Continuation Loop:** Fresh message history + `stripThinking`, auto-apply for writes *and* edits, bounded re-continues (max 2).
  - **Immutable tool card state** so running/done/error updates reliably in React.
  - **Universal Fallback Parser:** Markdown fences become writes only when create-intent is detected, an explicit path is present, or the Conductor assigned `expectedFilePath`.

### Phase 4: Conductor Swarm — Contract-First Two-Pass (Current State)
- **Pass 1 (Lead Architect):** High-VRAM `@coder` (or frontier backup) emits a JSON manifest — shared `contractCode` + per-file tasks with locked imports/exports. Thinking blocks stripped before `JSON.parse`.
- **Contract verify:** Electron writes the contract file and runs isolated `tsc --noEmit`; architect self-corrects once on failure before workers wake.
- **Pass 2 (GPU workers):** Tasks assigned by live tok/s × complexity × role bonus (`assignSwarmTasksToCluster`); each worker gets the contract injected read-only.
- **Workspace repair:** After `Promise.allSettled`, project `tsc --noEmit` routes errors back to the owning GPU for a targeted re-prompt.
- Local-first routing; frontier only when no local Ollama workers are online.
- Per-node model toggles, soft `roles`, and resizable sidebars unchanged.

---

## 4. Key Source Code Map

| File Path | Description |
|---|---|
| [`electron/main.cjs`](electron/main.cjs) | Electron main process, IPC tools, PowerShell, cluster pinging, and benchmarks. |
| [`electron/preload.cjs`](electron/preload.cjs) | Context-bridge API for the sandboxed renderer. |
| [`src/types.ts`](src/types.ts) | Core TypeScript types for nodes, benchmarks, tool calls, chat messages, and settings. |
| [`src/config/defaults.ts`](src/config/defaults.ts) | Default nodes, roles, personas, and settings. |
| [`src/lib/tools.ts`](src/lib/tools.ts) | System prompts, parsers, diff patcher, and routing helpers. |
| [`src/lib/swarmContract.ts`](src/lib/swarmContract.ts) | Contract-first Swarm manifest parse/prompts, Lead Architect selection, tok/s assignment, tsc error grouping. |
| [`src/lib/agentLoop.ts`](src/lib/agentLoop.ts) | Immutable tool execution, auto-apply, continuation helpers. |
| [`src/lib/ollamaClient.ts`](src/lib/ollamaClient.ts) | Streaming chat client (Ollama + OpenAI-compatible Frontier). |
| [`src/components/AgentChat.tsx`](src/components/AgentChat.tsx) | Agent Conductor chat, pipeline dispatch, tool review cards. |
| [`src/components/agent/ToolActionCard.tsx`](src/components/agent/ToolActionCard.tsx) | Per-tool apply / preview UI. |
| [`src/components/HardwareSettingsModal.tsx`](src/components/HardwareSettingsModal.tsx) | Node settings shell; delegates hub/installed-model panels. |
| [`src/components/hardware/`](src/components/hardware/) | Model hub + installed models / benchmark / pull UI. |
| [`src/components/FileTree.tsx`](src/components/FileTree.tsx) | Workspace file tree explorer with drag-resizable width support. |
| [`src/components/EditorView.tsx`](src/components/EditorView.tsx) | Multi-tab Monaco editor with dirty indicator and file save triggers. |
| [`src/components/TerminalPanel.tsx`](src/components/TerminalPanel.tsx) | Embedded PowerShell command runner with streaming output. |
| [`src/App.tsx`](src/App.tsx) | Top-level state, cluster poll merge, scoped agent writes, layout. |

---

## 5. Development & Run Commands

```powershell
# Install dependencies
npm install

# Type-check TypeScript
npx tsc --noEmit

# Production build
npm run build

# Run Electron desktop app in development
npm run dev
```
