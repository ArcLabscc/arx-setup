#!/usr/bin/env node

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// --- Constants ---

const ARX_API = process.env.ARX_URL || "https://api.synap.ing";
const CONFIG_DIR = path.join(os.homedir(), ".arx");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_DESKTOP_CONFIG_MAC = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json"
);
const CURSOR_CONFIG = path.join(os.homedir(), ".cursor", "mcp.json");

// --- UI Helpers ---

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function banner() {
  console.log(`
${CYAN}${BOLD}  ╔═══════════════════════════════════╗
  ║          ARX Setup v0.1           ║
  ║   Personal Knowledge Graph        ║
  ╚═══════════════════════════════════╝${RESET}
`);
}

function success(msg: string) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string) {
  console.log(`  ${YELLOW}!${RESET} ${msg}`);
}

function fail(msg: string) {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

// --- Prompt ---

function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question}`, (answer) => resolve(answer.trim()));
  });
}

function askPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    stdout.write(`  ${question}`);

    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    let password = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.pause();
        stdout.write("\n");
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007F" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          stdout.write("\b \b");
        }
      } else {
        password += c;
        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

// --- Auth ---

interface LoginResult {
  jwt: string;
  api_key: string;
  slug: string;
  admin?: boolean;
}

async function login(
  endpoint: string,
  email: string,
  password: string
): Promise<LoginResult> {
  const res = await fetch(`${endpoint}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) {
      throw new Error("Invalid email or password");
    }
    throw new Error(`Login failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    jwt: data.token as string,
    api_key: data.api_key as string,
    slug: data.slug as string,
    admin: data.admin as boolean | undefined,
  };
}

async function register(
  endpoint: string,
  email: string,
  password: string,
  slug: string
): Promise<LoginResult> {
  const res = await fetch(`${endpoint}/api/v2/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, slug }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409) {
      throw new Error("Account already exists. Use login instead.");
    }
    throw new Error(`Registration failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    jwt: data.token as string,
    api_key: data.api_key as string,
    slug: data.slug as string,
    admin: false,
  };
}

// --- Config Writers ---

interface ArxConfig {
  endpoint: string;
  api_key: string;
  slug: string;
}

function writeArxConfig(config: ArxConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function detectTools(): string[] {
  const found: string[] = [];

  // Claude Code
  try {
    if (fs.existsSync(path.join(os.homedir(), ".claude"))) {
      found.push("claude-code");
    }
  } catch {}

  // Claude Desktop
  try {
    if (fs.existsSync(CLAUDE_DESKTOP_CONFIG_MAC)) {
      found.push("claude-desktop");
    }
  } catch {}

  // Cursor
  try {
    if (fs.existsSync(path.join(os.homedir(), ".cursor"))) {
      found.push("cursor");
    }
  } catch {}

  return found;
}

function configureClaude(config: ArxConfig) {
  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf-8"));
    }

    const env = (settings.env as Record<string, string>) || {};
    env.ARX_URL = config.endpoint;
    env.ARX_API_KEY = config.api_key;
    settings.env = env;

    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    success("Claude Code settings.json — ARX env vars configured");
  } catch (err) {
    warn(`Claude Code settings.json — could not update: ${err}`);
  }
}

function configureClaudeDesktop(config: ArxConfig) {
  try {
    let desktopConfig: Record<string, unknown> = {};
    if (fs.existsSync(CLAUDE_DESKTOP_CONFIG_MAC)) {
      desktopConfig = JSON.parse(
        fs.readFileSync(CLAUDE_DESKTOP_CONFIG_MAC, "utf-8")
      );
    }

    const mcpServers =
      (desktopConfig.mcpServers as Record<string, unknown>) || {};
    mcpServers.arx = {
      command: "npx",
      args: ["-y", "@arx/mcp-server"],
      env: {
        ARX_URL: config.endpoint,
        ARX_API_KEY: config.api_key,
      },
    };
    desktopConfig.mcpServers = mcpServers;

    fs.writeFileSync(
      CLAUDE_DESKTOP_CONFIG_MAC,
      JSON.stringify(desktopConfig, null, 2) + "\n"
    );
    success("Claude Desktop — MCP server configured");
  } catch (err) {
    warn(`Claude Desktop — could not update: ${err}`);
  }
}

function configureCursor(config: ArxConfig) {
  try {
    let cursorConfig: Record<string, unknown> = {};
    if (fs.existsSync(CURSOR_CONFIG)) {
      cursorConfig = JSON.parse(fs.readFileSync(CURSOR_CONFIG, "utf-8"));
    }

    const mcpServers =
      (cursorConfig.mcpServers as Record<string, unknown>) || {};
    mcpServers.arx = {
      command: "npx",
      args: ["-y", "@arx/mcp-server"],
      env: {
        ARX_URL: config.endpoint,
        ARX_API_KEY: config.api_key,
      },
    };
    cursorConfig.mcpServers = mcpServers;

    fs.mkdirSync(path.dirname(CURSOR_CONFIG), { recursive: true });
    fs.writeFileSync(
      CURSOR_CONFIG,
      JSON.stringify(cursorConfig, null, 2) + "\n"
    );
    success("Cursor — MCP server configured");
  } catch (err) {
    warn(`Cursor — could not update: ${err}`);
  }
}

// --- Verify ---

async function verifyConnection(config: ArxConfig): Promise<boolean> {
  try {
    const res = await fetch(`${config.endpoint}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Main ---

async function main() {
  banner();

  // Check for existing config
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      info(`Existing config found: ${existing.slug}@${existing.endpoint}`);
      const rl = createPrompt();
      const choice = await ask(
        rl,
        "Reconfigure? (y/N): "
      );
      rl.close();
      if (choice.toLowerCase() !== "y") {
        console.log("");
        success("Keeping existing configuration");
        process.exit(0);
      }
    } catch {}
  }

  const rl = createPrompt();

  // Login or register
  console.log(`  ${BOLD}Connect to ARX${RESET}`);
  console.log("");

  const choice = await ask(rl, `${BOLD}(L)ogin${RESET} or ${BOLD}(C)reate account${RESET}? [L/c]: `);
  const isRegister = choice.toLowerCase() === "c";

  console.log("");

  const email = await ask(rl, "Email: ");
  rl.close(); // Close before password prompt (raw mode)

  const password = await askPassword("Password: ");

  let slug = "";
  if (isRegister) {
    const rl2 = createPrompt();
    slug = await ask(rl2, "Choose a username (slug): ");
    rl2.close();
  }

  console.log("");
  info("Authenticating...");

  let result: LoginResult;
  try {
    if (isRegister) {
      result = await register(ARX_API, email, password, slug);
      success(`Account created: ${result.slug}`);
    } else {
      result = await login(ARX_API, email, password);
      success(`Logged in as: ${result.slug}`);
    }
  } catch (err) {
    fail(`${err}`);
    process.exit(1);
  }

  if (result.admin) {
    success("Admin privileges detected");
  }

  // Write config
  console.log("");
  info("Writing configuration...");

  const config: ArxConfig = {
    endpoint: ARX_API,
    api_key: result.api_key,
    slug: result.slug,
  };

  writeArxConfig(config);
  success(`Config saved to ${CONFIG_PATH}`);

  // Detect and configure AI tools
  console.log("");
  info("Detecting AI tools...");

  const tools = detectTools();

  if (tools.length === 0) {
    warn("No AI tools detected. You can manually configure later.");
  } else {
    for (const tool of tools) {
      switch (tool) {
        case "claude-code":
          configureClaude(config);
          break;
        case "claude-desktop":
          configureClaudeDesktop(config);
          break;
        case "cursor":
          configureCursor(config);
          break;
      }
    }
  }

  // Verify connection
  console.log("");
  info("Verifying connection...");

  const healthy = await verifyConnection(config);
  if (healthy) {
    success("ARX server is reachable");
  } else {
    warn("ARX server not reachable — check your connection");
  }

  // Done
  console.log(`
${CYAN}${BOLD}  ╔═══════════════════════════════════╗
  ║          Setup Complete!          ║
  ╚═══════════════════════════════════╝${RESET}

  ${BOLD}Your next AI session has memory.${RESET}

  ${DIM}If using Claude Code, restart with /restart${RESET}
  ${DIM}If using Claude Desktop, restart the app${RESET}

  ${DIM}Commands available after restart:${RESET}
    ${CYAN}/arx${RESET} <query>     — Search your knowledge graph
    ${CYAN}/capture${RESET} <text>   — Save a thought
    ${CYAN}/recall${RESET} <query>   — Find by meaning

  ${DIM}Learn more: https://synap.ing/docs${RESET}
`);
}

main().catch((err) => {
  fail(`Unexpected error: ${err}`);
  process.exit(1);
});
