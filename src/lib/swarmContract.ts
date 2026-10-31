import { EndpointNode } from '../types';
import {
  inferDeliveryStack,
  isDeliveryStack,
  stackFromFilePaths,
  verifyCommandForStack,
  type DeliveryStack
} from './deliveryIntent';
import {
  getEnabledModelsForNode,
  getPreferredModelForNode,
  getPreferredRole,
  isFrontierNode,
  nodeHasExplicitRole,
  pickBestModelForComplexity,
  type ConductorFileJob
} from './tools';

export type SwarmComplexity = 'high' | 'medium' | 'low';
export type SwarmPreferredRole = '@coder' | '@docs' | '@reviewer';

export interface SwarmTask {
  filePath: string;
  complexity: SwarmComplexity;
  preferredRole: SwarmPreferredRole;
  requiredExports: string[];
  requiredImports: string[];
  instructions: string;
  /** Display role label for UI */
  role?: string;
}

export interface SwarmManifest {
  contractFile: string;
  contractCode: string;
  tasks: SwarmTask[];
  stack: DeliveryStack;
  verifyCommand?: string | null;
}

export interface SwarmAssignment {
  task: SwarmTask;
  node: EndpointNode;
  model: string;
  usedFrontierBackup?: boolean;
  skippedReason?: string;
}

/** One assigned file plus its pipeline-step index (step 0 is the contract). */
export interface SwarmWorkItem {
  assignment: SwarmAssignment;
  stepIdx: number;
}

/** Same Ollama URL shares one GPU, even if two node entries point at it. */
export function endpointQueueKey(node: EndpointNode): string {
  return (node.url || node.id || '').replace(/\/+$/, '').toLowerCase();
}

/**
 * One in-flight chat per GPU URL. Different URLs stay parallel.
 * The heaviest file's model is pinned for the whole queue so a 16GB card
 * does not load a 14B and a 7B at the same time.
 */
export function queueAssignmentsByGpu(assignments: SwarmAssignment[]): SwarmWorkItem[][] {
  const queues = new Map<string, SwarmWorkItem[]>();
  assignments.forEach((assignment, i) => {
    const key = endpointQueueKey(assignment.node);
    const queue = queues.get(key) ?? [];
    queue.push({ assignment, stepIdx: i + 1 });
    queues.set(key, queue);
  });

  for (const queue of queues.values()) {
    let heaviest = queue[0];
    for (const item of queue) {
      const itemWeight = COMPLEXITY_WEIGHT[item.assignment.task.complexity];
      const bestWeight = COMPLEXITY_WEIGHT[heaviest.assignment.task.complexity];
      if (itemWeight > bestWeight) heaviest = item;
    }
    const pinned = heaviest.assignment.model;
    for (const item of queue) item.assignment.model = pinned;
  }

  return [...queues.values()];
}

const COMPLEXITY_WEIGHT: Record<SwarmComplexity, number> = {
  high: 3,
  medium: 2,
  low: 1
};

/** Map swarm complexity → existing Conductor complexity labels. */
export function toConductorComplexity(
  c: SwarmComplexity
): ConductorFileJob['complexity'] {
  if (c === 'high') return 'heavy';
  if (c === 'low') return 'light';
  return 'medium';
}

export function stripThinkBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Pull the outermost `{...}` with brace counting (ignores braces inside strings). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Fix common local-model JSON mistakes before parse. */
export function sanitizeLooseJson(raw: string): string {
  let s = raw.trim();
  // Trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Unescaped newlines inside double-quoted strings (best-effort)
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        out += ch;
        escape = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        out += '\\n';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Parse Pass-1 Lead Architect JSON (tolerates fences + think blocks).
 */
export function parseSwarmManifest(raw: string, userTask: string): SwarmManifest | null {
  try {
    let cleaned = stripThinkBlocks(raw);
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    const slice = extractJsonObject(cleaned);
    if (!slice) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(slice);
    } catch {
      parsed = JSON.parse(sanitizeLooseJson(slice));
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const contractFile = String(parsed.contractFile || 'src/types/swarm-contract.ts')
      .trim()
      .replace(/^[\\/]+/, '')
      .replace(/\.\.[\\/]+/g, '');
    let contractCode = String(parsed.contractCode || '').trim();
    if (!contractCode) return null;
    // Strip accidental fences inside contractCode
    contractCode = contractCode
      .replace(/^\s*```(?:typescript|ts)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '');

    const seen = new Set<string>();
    const tasks: SwarmTask[] = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .filter((t: any) => t && typeof t.filePath === 'string' && t.filePath.trim())
      .map((t: any) => {
        const filePath = String(t.filePath)
          .trim()
          .replace(/^[\\/]+/, '')
          .replace(/\.\.[\\/]+/g, '');
        const complexity: SwarmComplexity =
          t.complexity === 'high' || t.complexity === 'low' || t.complexity === 'medium'
            ? t.complexity
            : t.complexity === 'heavy'
              ? 'high'
              : t.complexity === 'light'
                ? 'low'
                : 'medium';
        const preferredRole: SwarmPreferredRole =
          t.preferredRole === '@docs' || t.preferredRole === '@reviewer' ? t.preferredRole : '@coder';
        return {
          filePath,
          complexity,
          preferredRole,
          requiredExports: Array.isArray(t.requiredExports)
            ? t.requiredExports.map(String)
            : [],
          requiredImports: Array.isArray(t.requiredImports)
            ? t.requiredImports.map(String)
            : [],
          instructions:
            String(t.instructions || '').trim() ||
            `Implement ${filePath} for: ${userTask}`,
          role: String(t.role || preferredRole || 'Worker')
        } as SwarmTask;
      })
      .filter((t: SwarmTask) => {
        const key = t.filePath.toLowerCase();
        if (seen.has(key)) return false;
        if (key === contractFile.toLowerCase()) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);

    if (!tasks.length) return null;
    const fromFiles = stackFromFilePaths(tasks.map(t => t.filePath));
    const declared = isDeliveryStack(String(parsed.stack || '')) ? (parsed.stack as DeliveryStack) : null;
    const stack = declared || fromFiles || inferDeliveryStack(userTask);
    const verifyCommand =
      typeof parsed.verifyCommand === 'string' && parsed.verifyCommand.trim()
        ? String(parsed.verifyCommand).trim()
        : verifyCommandForStack(stack);
    return { contractFile, contractCode, tasks, stack, verifyCommand };
  } catch {
    return null;
  }
}

/** Deterministic fallback when Pass 1 JSON fails — still produces a usable contract. */
export function fallbackSwarmManifest(userTask: string): SwarmManifest {
  const stack = inferDeliveryStack(userTask);
  const verifyCommand = verifyCommandForStack(stack);
  if (stack === 'python') {
    return {
      stack,
      verifyCommand,
      contractFile: 'SWARM.md',
      contractCode: `# Shared names\nProject: ${userTask.slice(0, 200)}\n`,
      tasks: [
        {
          filePath: 'main.py',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `Implement the Python program for: ${userTask}`,
          role: 'Main'
        },
        {
          filePath: 'README.md',
          complexity: 'low',
          preferredRole: '@docs',
          requiredExports: [],
          requiredImports: [],
          instructions: `Short run instructions for: ${userTask}`,
          role: 'Docs'
        }
      ]
    };
  }
  if (stack === 'go') {
    return {
      stack,
      verifyCommand,
      contractFile: 'SWARM.md',
      contractCode: `# Shared names\n`,
      tasks: [
        {
          filePath: 'go.mod',
          complexity: 'low',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: 'Create a go.mod module named example.com/app',
          role: 'Module'
        },
        {
          filePath: 'main.go',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `Implement the Go program for: ${userTask}`,
          role: 'Main'
        }
      ]
    };
  }
  if (stack === 'rust') {
    return {
      stack,
      verifyCommand,
      contractFile: 'SWARM.md',
      contractCode: `# Shared names\n`,
      tasks: [
        {
          filePath: 'Cargo.toml',
          complexity: 'low',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: 'Cargo.toml for a binary named app',
          role: 'Cargo'
        },
        {
          filePath: 'src/main.rs',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `Implement the Rust program for: ${userTask}`,
          role: 'Main'
        }
      ]
    };
  }
  if (stack === 'node') {
    return {
      stack,
      verifyCommand,
      contractFile: 'SWARM.md',
      contractCode: `# Shared names\n`,
      tasks: [
        {
          filePath: 'package.json',
          complexity: 'medium',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `package.json for: ${userTask}`,
          role: 'Package'
        },
        {
          filePath: 'main.js',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `Implement the Node/Electron entry for: ${userTask}`,
          role: 'Main'
        }
      ]
    };
  }
  if (stack === 'static-web') {
    return {
      stack,
      verifyCommand,
      contractFile: 'SWARM.md',
      contractCode: `# Shared names\nUse the same product names, prices, and image paths in every file.\n`,
      tasks: [
        {
          filePath: 'index.html',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `Complete static page for: ${userTask}. Link styles.css and app.js. Use generate_image paths under assets/ when pictures are needed.`,
          role: 'HTML'
        },
        {
          filePath: 'styles.css',
          complexity: 'medium',
          preferredRole: '@docs',
          requiredExports: [],
          requiredImports: [],
          instructions: `Styles for: ${userTask}`,
          role: 'CSS'
        },
        {
          filePath: 'app.js',
          complexity: 'medium',
          preferredRole: '@coder',
          requiredExports: [],
          requiredImports: [],
          instructions: `Browser script (cart or behavior) for: ${userTask}`,
          role: 'JS'
        }
      ]
    };
  }

  const lower = userTask.toLowerCase();
  const isWeb =
    /\b(web|webpage|website|html|react|ui|dashboard|frontend)\b/.test(lower) ||
    !/\b(python|tkinter|desktop|windows app|cli)\b/.test(lower);

  if (isWeb) {
    return {
      stack: 'typescript',
      verifyCommand: null,
      contractFile: 'src/types/swarm-contract.ts',
      contractCode: `/** Shared contract for Conductor Swarm — do not redefine in worker files. */
export interface AppState {
  title: string;
  ready: boolean;
}

export type AppMessage = { type: 'ready' } | { type: 'error'; message: string };

export function createInitialState(): AppState {
  return { title: 'App', ready: false };
}
`,
      tasks: [
        {
          filePath: 'src/app.ts',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: ['export function boot(): void'],
          requiredImports: [
            "import type { AppState } from './types/swarm-contract';",
            "import { createInitialState } from './types/swarm-contract';"
          ],
          instructions: `Implement application bootstrap using createInitialState for: ${userTask}`,
          role: 'Core App'
        },
        {
          filePath: 'src/ui.ts',
          complexity: 'medium',
          preferredRole: '@docs',
          requiredExports: ['export function renderApp(root: HTMLElement, state: AppState): void'],
          requiredImports: ["import type { AppState } from './types/swarm-contract';"],
          instructions: `Implement UI rendering helpers for: ${userTask}`,
          role: 'UI'
        },
        {
          filePath: 'index.html',
          complexity: 'low',
          preferredRole: '@reviewer',
          requiredExports: [],
          requiredImports: [],
          instructions: `Create index.html that loads the app entry for: ${userTask}`,
          role: 'HTML Shell'
        }
      ]
    };
  }

  return {
    stack: 'typescript',
    verifyCommand: null,
    contractFile: 'src/types/swarm-contract.ts',
    contractCode: `/** Shared contract for Conductor Swarm. */
export interface AppConfig {
  name: string;
  version: string;
}

export function getDefaultConfig(): AppConfig {
  return { name: 'app', version: '0.1.0' };
}
`,
    tasks: [
      {
        filePath: 'src/main.ts',
        complexity: 'high',
        preferredRole: '@coder',
        requiredExports: ['export function main(): void'],
        requiredImports: [
          "import type { AppConfig } from './types/swarm-contract';",
          "import { getDefaultConfig } from './types/swarm-contract';"
        ],
        instructions: `Implement main entry for: ${userTask}`,
        role: 'Main'
      },
      {
        filePath: 'src/services.ts',
        complexity: 'medium',
        preferredRole: '@coder',
        requiredExports: ['export function describeConfig(cfg: AppConfig): string'],
        requiredImports: ["import type { AppConfig } from './types/swarm-contract';"],
        instructions: `Implement service helpers for: ${userTask}`,
        role: 'Services'
      }
    ]
  };
}

export function buildLeadArchitectPrompt(
  userTask: string,
  workspaceOverview: string,
  existingSnippets: string,
  approvedPlanText?: string | null,
  workLog?: string | null,
  devHostSection?: string | null
): string {
  const planSection = approvedPlanText?.trim()
    ? `
### APPROVED PLAN (user already chose — follow this architecture)
${approvedPlanText.trim()}

If the approved plan chooses static HTML/CSS/JS (or similar), still return valid JSON but set tasks to those HTML/CSS/JS paths. Use a minimal contractFile (e.g. \`src/types/swarm-contract.ts\` exporting shared string constants or empty interfaces) only when needed for TS workers; for pure static sites, prefer task filePaths like \`index.html\`, \`styles.css\`, \`app.js\` and keep contractCode as a tiny valid TS module.
`
    : '';

  const hostBlock = devHostSection?.trim()
    ? `
### DEVELOPMENT HOST
${devHostSection.trim()}
Workers may run on other GPUs; they still write into this Dev workspace. Installs and run_command execute on the Dev PC only.
`
    : `
### DEVELOPMENT HOST
The workspace, installs, and terminal live on the Dev PC where LocalAgents Studio is open — not necessarily on the GPU that runs this pass. Plan file paths for that Dev workspace.
`;

  return `You are the Lead Architect (@coder) for LocalAgents Studio's Conductor Swarm.
Your job is to decompose a multi-file coding request into a strict TypeScript contract BEFORE parallel GPU workers write the implementation files.
When an APPROVED PLAN is present, honor the chosen stack and scope instead of inventing a different one.
${hostBlock}
### WORKSPACE CONTEXT
Existing file tree:
${workspaceOverview || '(empty or unknown)'}

Relevant existing files:
${existingSnippets || '(none loaded)'}

### WORK LOG
${workLog?.trim() || '(none yet)'}
Do not assign a task that is already under Done. Do not ask the user a question listed under Already asked. Plan the Next step, then only the files that step still needs.

### USER REQUEST
${userTask}
${planSection}
### OUTPUT REQUIREMENTS
Respond ONLY with a valid JSON object matching this exact schema. Do NOT write implementation bodies.
1. \`contractFile\`: Path where shared interfaces/types must be written (or updated). Prefer \`src/types/swarm-contract.ts\`.
2. \`contractCode\`: Complete, valid TypeScript that typechecks alone. Prefer shared \`interface\`/\`type\`/\`enum\`. If the contract exports helpers, include minimal stub bodies (not ambient \`declare\`) so \`tsc --noEmit\` succeeds.
3. \`tasks\`: Array of distinct files to implement in parallel. Each task MUST have a unique \`filePath\` (never the contract file, never duplicates).
4. \`stack\`: one of "typescript", "static-web", "python", "go", "rust", "node". Use static-web for browser pages that should open without a build. Use typescript only when the user asked for React/TypeScript or the repo is already TypeScript.
5. \`verifyCommand\`: one shell command to check the result, or null for typescript (tsc is run separately).

Schema:
{
  "contractFile": "src/types/swarm-contract.ts",
  "contractCode": "export interface Example { id: string }\\n",
  "tasks": [
    {
      "filePath": "src/example.ts",
      "complexity": "high",
      "preferredRole": "@coder",
      "requiredExports": ["export function run(): void"],
      "requiredImports": ["import type { Example } from './types/swarm-contract';"],
      "instructions": "Implement run() using the shared contract."
    }
  ]
}

Use complexity "high" | "medium" | "low" and preferredRole "@coder" | "@docs" | "@reviewer".
Prefer 2–4 tasks. Output JSON only.`;
}

export function buildContractRepairPrompt(
  userTask: string,
  previous: SwarmManifest,
  tscError: string
): string {
  return `You previously produced a Swarm TypeScript contract that failed typecheck.

### USER REQUEST
${userTask}

### PREVIOUS MANIFEST (fix contractCode; keep tasks unless a path must change)
${JSON.stringify(previous, null, 2)}

### TSC ERRORS
${tscError}

Return the FULL corrected JSON manifest (same schema). Fix \`contractCode\` so \`tsc --noEmit\` succeeds. JSON only.`;
}

export function buildSwarmWorkerPrompt(opts: {
  task: SwarmTask;
  contractFile: string;
  contractCode: string;
  siblingSummary: string;
  currentFileContent?: string;
  userPrompt: string;
  /** Dev-host context (workspace/installs on Studio PC) */
  devHostSection?: string | null;
}): string {
  const { task, contractFile, contractCode, siblingSummary, currentFileContent, userPrompt } = opts;
  const imports = task.requiredImports.length
    ? task.requiredImports.map(i => `- ${i}`).join('\n')
    : '- (none specified — import shared types from the contract path as needed)';
  const exports = task.requiredExports.length
    ? task.requiredExports.map(e => `- ${e}`).join('\n')
    : '- (export the public API described in the instructions)';
  const hostBlock = opts.devHostSection?.trim()
    ? `
### DEVELOPMENT HOST
${opts.devHostSection.trim()}
You are a collaborative multimodal worker: generate code for the Dev workspace, and when images are in context analyze them. Tool tags that touch files or the terminal execute on the Dev PC — do not treat your GPU host as the install/run machine.
`
    : `
### DEVELOPMENT HOST
Workspace files, package installs, and run_command execute on the Dev PC (where Studio is open), not on your GPU host. You still fully collaborate — code, review context, and vision when images are provided — for that Dev workspace.
`;

  return `You are an autonomous GPU Worker in a distributed Conductor Swarm.
You are assigned to implement ONE specific file: \`${task.filePath}\`.
Other GPU nodes are simultaneously writing the sibling files.
${hostBlock}
### STRICT CONTRACT RULES (DO NOT VIOLATE)
1. You MUST import shared types exactly as specified:
${imports}

2. Here is the exact read-only TypeScript contract (\`${contractFile}\`) already written to disk:
\`\`\`typescript
${contractCode}
\`\`\`

3. Your file MUST export these exact signatures (do not rename parameters, return types, or export names):
${exports}

4. Do NOT redefine interfaces/types that already exist in \`${contractFile}\`.
5. Scope your output strictly to \`${task.filePath}\`.

### SIBLING FILES (written in parallel)
${siblingSummary}

### CURRENT FILE CONTENT
${currentFileContent?.trim()
  ? currentFileContent
  : '(new file — create it from scratch)'}

### TASK INSTRUCTIONS
${task.instructions}

### OVERALL USER REQUEST
${userPrompt}

Output the complete file using:
<write_file path="${task.filePath}">
...complete code...
</write_file>
Do not omit code with placeholders.`;
}

export function buildRepairWorkerPrompt(opts: {
  task: SwarmTask;
  contractFile: string;
  contractCode: string;
  currentFileContent: string;
  tscErrors: string;
  devHostSection?: string | null;
}): string {
  const host = opts.devHostSection?.trim()
    ? `\n### DEVELOPMENT HOST\n${opts.devHostSection.trim()}\nFixes apply to the Dev workspace; installs/runtime are on that PC.\n`
    : '';
  return `You own \`${opts.task.filePath}\` in a Conductor Swarm. Workspace typecheck failed for your file.
${host}
### CONTRACT (\`${opts.contractFile}\`) — read-only
\`\`\`typescript
${opts.contractCode}
\`\`\`

### REQUIRED EXPORTS
${opts.task.requiredExports.map(e => `- ${e}`).join('\n') || '(see file)'}

### REQUIRED IMPORTS
${opts.task.requiredImports.map(i => `- ${i}`).join('\n') || '(see file)'}

### CURRENT FILE
\`\`\`
${opts.currentFileContent}
\`\`\`

### TSC ERRORS (fix these)
${opts.tscErrors}

Output a corrected full file via:
<write_file path="${opts.task.filePath}">
...fixed code...
</write_file>`;
}

function nodeTokPerSec(n: EndpointNode, model: string): number {
  const bm = n.benchmarks?.[model];
  if (bm?.evalTokPerSec) return Math.max(bm.evalTokPerSec, 5);
  if (isFrontierNode(n)) return 80;
  return Math.max(Math.round((n.hardware?.gpuBandwidthGBs || 300) / 6), 5);
}

function roleMatches(n: EndpointNode, preferred: SwarmPreferredRole): boolean {
  const role = getPreferredRole(n);
  if (preferred === '@coder') return role === 'coder' || role === 'planner';
  if (preferred === '@docs') return role === 'docs';
  if (preferred === '@reviewer') return role === 'reviewer';
  return false;
}

/**
 * Lead Architect (Pass-1): Preferred Role = Planner wins (frontier allowed).
 * Otherwise high-VRAM local (≥16GB), else best local, else frontier.
 */
export function findLeadArchitect(
  nodes: EndpointNode[]
): { node: EndpointNode; model: string; tokPerSec: number; usedFrontierBackup?: boolean } | null {
  const online = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const local = online.filter(n => !isFrontierNode(n));
  const highVram = local.filter(n => (n.hardware?.vramGB || 0) >= 16);
  const explicitPlanners = online.filter(n => nodeHasExplicitRole(n, 'planner'));

  const scoreNode = (n: EndpointNode) => {
    const model = pickBestModelForComplexity(n, 'heavy');
    const speed = nodeTokPerSec(n, model);
    const vram = n.hardware?.vramGB || 0;
    const roleBonus = roleMatches(n, '@coder') ? 200 : 0;
    return { model, speed, score: vram * 50 + speed + roleBonus };
  };

  const pool =
    explicitPlanners.length > 0
      ? explicitPlanners
      : highVram.length > 0
        ? highVram
        : local.length > 0
          ? local
          : online;
  if (!pool.length) return null;

  let best = pool[0];
  let bestMeta = scoreNode(best);
  for (const n of pool) {
    const meta = scoreNode(n);
    if (meta.score > bestMeta.score) {
      best = n;
      bestMeta = meta;
    }
  }

  return {
    node: best,
    model: bestMeta.model,
    tokPerSec: bestMeta.speed,
    // Intentional Planner tag on frontier is not a "backup" failover
    usedFrontierBackup: explicitPlanners.length === 0 && isFrontierNode(best)
  };
}

/**
 * Assign Pass-2 tasks across online GPUs using live tok/s + complexity + role bonus.
 * Local-first: frontier only when no local workers exist.
 */
export function assignSwarmTasksToCluster(
  tasks: SwarmTask[],
  nodes: EndpointNode[]
): SwarmAssignment[] {
  const online = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const local = online.filter(n => !isFrontierNode(n));
  const frontier = online.filter(isFrontierNode);
  const usedFrontierBackup = local.length === 0 && frontier.length > 0;
  const activeNodes = local.length > 0 ? local : frontier;

  const sortedTasks = [...tasks].sort(
    (a, b) => COMPLEXITY_WEIGHT[b.complexity] - COMPLEXITY_WEIGHT[a.complexity]
  );

  if (!activeNodes.length) {
    const any = nodes.filter(n => getEnabledModelsForNode(n).length > 0);
    const pool = any.length ? any : nodes;
    if (!pool.length) return [];
    return sortedTasks.map((task, idx) => {
      const node = pool[idx % pool.length];
      return {
        task,
        node,
        model: pickBestModelForComplexity(node, toConductorComplexity(task.complexity)),
        skippedReason: node.online ? undefined : 'Node offline — assignment may fail',
        usedFrontierBackup: isFrontierNode(node)
      };
    });
  }

  const nodeLoad = new Map<string, number>(activeNodes.map(n => [n.id, 0]));

  return sortedTasks.map(task => {
    let bestNode = activeNodes[0];
    let bestScore = Infinity;

    for (const node of activeNodes) {
      const model = pickBestModelForComplexity(node, toConductorComplexity(task.complexity));
      const speed = nodeTokPerSec(node, model);
      const currentLoad = nodeLoad.get(node.id) ?? 0;
      const estimatedTokens = COMPLEXITY_WEIGHT[task.complexity] * 400;
      const roleBonus = roleMatches(node, task.preferredRole) ? 0.75 : 1.0;
      const estimatedTimeCost = ((currentLoad + estimatedTokens) / speed) * roleBonus;
      if (estimatedTimeCost < bestScore) {
        bestScore = estimatedTimeCost;
        bestNode = node;
      }
    }

    const model = pickBestModelForComplexity(
      bestNode,
      toConductorComplexity(task.complexity)
    );
    nodeLoad.set(
      bestNode.id,
      (nodeLoad.get(bestNode.id) ?? 0) + COMPLEXITY_WEIGHT[task.complexity] * 400
    );

    return {
      task,
      node: bestNode,
      model,
      usedFrontierBackup,
      skippedReason: usedFrontierBackup
        ? 'Frontier backup — no local Ollama nodes online'
        : undefined
    };
  });
}

/** Group tsc stderr lines by relative file path (best-effort). */
export function groupTscErrorsByFile(
  tscOutput: string,
  workspaceRoot: string
): Map<string, string> {
  const map = new Map<string, string>();
  const rootNorm = workspaceRoot.replace(/[\\/]+$/, '').toLowerCase();
  const lines = tscOutput.split(/\r?\n/);
  let currentFile = '';

  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error TS\d+:.+)$/i)
      || line.match(/^(.+?):(\d+):(\d+)\s+-\s+(error TS\d+:.+)$/i);
    if (m) {
      let file = m[1].trim().replace(/\\/g, '/');
      const absLower = file.toLowerCase();
      if (absLower.startsWith(rootNorm.replace(/\\/g, '/'))) {
        file = file.slice(workspaceRoot.length).replace(/^[\\/]+/, '');
      }
      // Also handle paths already relative
      file = file.replace(/\\/g, '/');
      currentFile = file;
      const prev = map.get(currentFile) || '';
      map.set(currentFile, prev ? `${prev}\n${line}` : line);
    } else if (currentFile && line.trim()) {
      map.set(currentFile, `${map.get(currentFile)}\n${line}`);
    }
  }
  return map;
}

export function isTypeScriptContractPath(filePath: string): boolean {
  return /\.tsx?$/i.test(filePath);
}
