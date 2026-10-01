import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

let accounts = null;
let rates = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ACCOUNTS = "./state/accounts.json";
const RATES = "./state/rates.json";
const LOG = "./state/log.jsonl";
const LEGACY_LOG = "./state/log.json";

export async function init() {
  accounts = await load(ACCOUNTS);
  rates = await load(RATES);
  await migrateLegacyLog();

  scheduleSave(accounts, ACCOUNTS, 1000);
  scheduleSave(rates, RATES, 5000);
}

export function getAccounts() {
  return accounts;
}

export function getRates() {
  return rates;
}

export async function getLog() {
  return loadLog();
}

async function load(fileName) {
  const filePath = path.join(__dirname, fileName);

  try {
    await fs.promises.access(filePath);
    const raw = await fs.promises.readFile(filePath, "utf8");
    
    return JSON.parse(raw);
  } catch (err) {
    if (err.code == "ENOENT") {
      console.error(`${filePath} not found`);
    } else {
      console.error(`Error loading ${filePath}:`, err);
    }
  }
}

async function loadLog() {
  const filePath = path.join(__dirname, LOG);

  try {
    const raw = await fs.promises.readFile(filePath, "utf8");

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code != "ENOENT") {
      console.error(`Error loading ${filePath}:`, err);
    }

    return [];
  }
}

async function migrateLegacyLog() {
  const logPath = path.join(__dirname, LOG);
  const legacyPath = path.join(__dirname, LEGACY_LOG);

  try {
    await fs.promises.access(logPath);
    return;
  } catch (err) {
    if (err.code != "ENOENT") {
      console.error(`Error checking ${logPath}:`, err);
      return;
    }
  }

  try {
    const raw = await fs.promises.readFile(legacyPath, "utf8");
    const entries = JSON.parse(raw);

    if (!Array.isArray(entries)) {
      console.error(`Error migrating ${legacyPath}: expected an array`);
      return;
    }

    await fs.promises.writeFile(
      logPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "")
    );
  } catch (err) {
    if (err.code != "ENOENT") {
      console.error(`Error migrating ${legacyPath}:`, err);
    }
  }
}

export async function appendLog(entry) {
  const filePath = path.join(__dirname, LOG);

  try {
    await fs.promises.appendFile(filePath, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`Error appending to ${filePath}:`, err);
  }
}

async function save(data, fileName) {
  const filePath = path.join(__dirname, fileName);
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err);
  }
}

function scheduleSave(data, fileName, period) {
  setInterval(async () => {
    await save(data, fileName);
  }, period);
}
