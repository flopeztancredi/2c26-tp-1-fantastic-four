import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

let accounts = null;
let rates = null;
let log = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "state");

const ACCOUNTS = "accounts.json";
const RATES = "rates.json";
const LOG = "log.json";

let saveIntervals = [];
const pendingSaves = new Set();

export async function init() {
  accounts = await load(ACCOUNTS);
  rates = await load(RATES);
  log = await load(LOG);

  saveIntervals = [
    scheduleSave(accounts, ACCOUNTS, 1000),
    scheduleSave(rates, RATES, 5000),
    scheduleSave(log, LOG, 1000),
  ];
}

export function getAccounts() {
  return accounts;
}

export function getRates() {
  return rates;
}

export function getLog() {
  return log;
}

//saves everything once, used on shutdown
export async function saveAll() {
  saveIntervals.forEach(clearInterval);
  await Promise.all(pendingSaves);

  await Promise.all([
    save(accounts, ACCOUNTS),
    save(rates, RATES),
    save(log, LOG),
  ]);
}

async function load(fileName) {
  const filePath = path.join(STATE_DIR, fileName);

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

async function save(data, fileName) {
  const filePath = path.join(STATE_DIR, fileName);
  const write = fs.promises
    .writeFile(filePath, JSON.stringify(data, null, 2))
    .catch((err) => console.error(`Error writing to ${filePath}:`, err));

  pendingSaves.add(write);
  await write;
  pendingSaves.delete(write);
}

function scheduleSave(data, fileName, period) {
  return setInterval(async () => {
    await save(data, fileName);
  }, period);
}
