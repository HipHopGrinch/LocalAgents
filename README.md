# LocalAgents Studio

An autonomous, distributed local-agent IDE built for a multi-PC Ollama cluster with optional Frontier Cloud fallback (xAI Grok, OpenAI, OpenRouter).

---

## Cluster & Hardware Architecture

| Node | Hostname / IP | Hardware Specs | Best Fit Role |
| :--- | :--- | :--- | :--- |
| **Main Rig** | `127.0.0.1:11434` | 9800X3D · RTX 5070 Ti (16GB) · 64GB DDR5 | Lead Architect & Coder (`@coder`) |
| **Linux Server** | `192.168.1.74:11434` (`ubuntu`) | 3900X · GTX 1080 Ti (11GB) · 32GB DDR4 | Vector Indexer & Docs (`@docs`) |
| **ROG Laptop** | `192.168.1.80:11434` (`ROGLaptop`) | 5900HX · RTX 3060 (6GB) · 32GB DDR4 | Fast Reviewer & Linter (`@reviewer`) |
| **Frontier API** | `https://api.x.ai/v1` | xAI Grok Supercluster | Deep Frontier Reasoning (Optional) |

---

## Key Features

### Live Token/Sec Benchmarking
- In **Hardware Settings**, click **Benchmark** next to any installed model.
- Measures generation speed (tok/s), prompt eval speed, and VRAM load latency via a short Ollama `/api/generate` coding prompt (`num_predict: 64`).
- Seeded default speeds show as **(estimate)** until you run a live benchmark; live results drive Conductor routing.

### Hybrid Local + Frontier API Support
- Route routine coding to local GPUs; optionally send work to Grok / OpenAI / OpenRouter.
- Enter an API key in Hardware Settings. Keys are stored in **plaintext** in Electron `userData/settings.json` on this machine (not encrypted).

### Token Economy Tracker
- Header badge tracks free local tokens vs frontier tokens and estimated API cost avoided.

### Hardware Recommender & Model Hub
- Catalog with VRAM fit (full GPU / offload / won't fit) and one-click remote **Pull Model**.

### Autonomous Workspace Tools
- `edit_file` SEARCH/REPLACE preview, `write_file` apply, `run_command` with captured PowerShell output.
- Read-only tools auto-run and continue the agent loop (bounded).
- Agent writes are scoped to the open workspace folder.

### Conductor Swarm
- Decomposes multi-file tasks and assigns distinct files across online GPUs using each node's selected model.

---

## Running the App

```powershell
cd C:\Users\rober\LocalAgents
.\start.bat
# or
npm start
```

Development:

```powershell
npm install
npm run dev
```

See [HISTORY.md](HISTORY.md) for architecture and evolution notes.
