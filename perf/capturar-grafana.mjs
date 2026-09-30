#!/usr/bin/env node
// captura en PNG cada panel del dashboard de Grafana para una carpeta de resultados ya corrida.
// uso y detalle completo: GUIA_suite.md. resumen: node capturar-grafana.mjs <carpeta> [prefijo]
//
// usa /usr/bin/google-chrome (headless) via puppeteer-core, sin descargar Chromium aparte.
// variables de entorno: GRAFANA_URL (default http://localhost), GRAFANA_USER y GRAFANA_PASS
// (default admin/admin, los valores por defecto del proyecto).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = "/usr/bin/google-chrome";
const MARGEN_S = 30; // segundos de margen antes y despues de inicio/fin, para capturas
const ANCHO = 1600;
const ALTO = 800;

const grafanaUrl = (process.env.GRAFANA_URL ?? "http://localhost").replace(/\/+$/, "");
const grafanaUser = process.env.GRAFANA_USER ?? "admin";
const grafanaPass = process.env.GRAFANA_PASS ?? "admin";

const [, , carpeta, prefijoArg] = process.argv;
if (!carpeta) {
  console.error("Uso: node capturar-grafana.mjs <carpeta-de-resultados> [prefijo]");
  process.exit(2);
}
if (!fs.existsSync(carpeta)) {
  console.error(`ERROR: no existe la carpeta ${carpeta}`);
  process.exit(1);
}

function leerEntero(archivo) {
  const p = path.join(carpeta, archivo);
  if (!fs.existsSync(p)) {
    console.error(`ERROR: falta ${p} (lo escribe correr-breakpoint-linux.sh)`);
    process.exit(1);
  }
  return parseInt(fs.readFileSync(p, "utf8").trim(), 10);
}

// el prefijo de statsd de este escenario: si no lo pasan, sale del yaml copiado en la carpeta
// (mismo criterio de correr-breakpoint-linux.sh: exchange-<categoria>-<corto> -> "corto")
function derivarPrefijo() {
  const yaml = fs.readdirSync(carpeta).find((f) => f.endsWith(".yaml"));
  if (!yaml) {
    console.error(`ERROR: no encontre un .yaml en ${carpeta} para deducir el prefijo, pasalo como segundo argumento`);
    process.exit(1);
  }
  const corto = yaml.replace(/\.yaml$/, "").replace(/^exchange-[^-]+-/, "");
  return `artillery-exchange-${corto}`;
}

// containers de esta corrida (exchange-api-1..N, nginx y redis si corresponde), leyendo
// API_REPLICAS/STATE_ADAPTER de entorno.txt (los escribe correr-breakpoint-linux.sh). una
// carpeta vieja que no los tenga (de antes de este campo) asume 1 replica y sin redis.
function leerContainers() {
  const p = path.join(carpeta, "entorno.txt");
  let replicas = 1;
  let adapter = "archivos";
  if (fs.existsSync(p)) {
    const texto = fs.readFileSync(p, "utf8");
    const mReplicas = texto.match(/^API_REPLICAS=(\d+)$/m);
    const mAdapter = texto.match(/^STATE_ADAPTER=(\S+)$/m);
    if (mReplicas) replicas = parseInt(mReplicas[1], 10);
    if (mAdapter) adapter = mAdapter[1];
  }
  const containers = [];
  for (let i = 1; i <= replicas; i++) containers.push(`exchange-api-${i}`);
  containers.push("exchange-nginx-1");
  if (adapter === "redis") containers.push("exchange-redis-1");
  return containers;
}

const inicio = leerEntero("inicio.txt");
const fin = leerEntero("fin.txt");
const prefijo = prefijoArg ?? derivarPrefijo();
const containers = leerContainers();
const from = (inicio - MARGEN_S) * 1000;
const to = (fin + MARGEN_S) * 1000;

const dashboardPath = new URL("./dashboard.json", import.meta.url);
const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));
const uid = dashboard.uid;
const paneles = dashboard.panels.filter((p) => p.type !== "row");

function nombreArchivo(panel) {
  const slug = panel.title
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // saca acentos
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `panel-${panel.id}-${slug}.png`;
}

async function obtenerSlug() {
  const url = `${grafanaUrl}/api/dashboards/uid/${uid}`;
  const auth = Buffer.from(`${grafanaUser}:${grafanaPass}`).toString("base64");
  const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) {
    throw new Error(`no pude leer ${url}: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.meta.slug;
}

// espera a que el panel termine de cargar: sin spinner de carga visible y con algo de contenido
// dibujado (canvas o svg). ademas un margen fijo chico para que termine de pintar.
async function esperarPanel(page) {
  try {
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Panel loading bar"], .panel-loading, [data-testid="Spinner"]'),
      { timeout: 15000 }
    );
  } catch {
    console.warn("  aviso: siguio cargando mas de 15 s, capturo igual");
  }
  await page.waitForSelector("canvas, svg", { timeout: 10000 }).catch(() => {
    console.warn("  aviso: no encontre canvas/svg, capturo igual (puede salir un panel vacio)");
  });
  await new Promise((r) => setTimeout(r, 800));
}

async function main() {
  const destino = path.join(carpeta, "capturas");
  fs.mkdirSync(destino, { recursive: true });

  const slug = await obtenerSlug();
  console.log(`Grafana: ${grafanaUrl}, dashboard ${uid}/${slug}, prefijo ${prefijo}`);
  console.log(`Containers: ${containers.join(", ")}`);
  console.log(`Rango: ${new Date(from).toISOString()} a ${new Date(to).toISOString()}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    // header de autenticacion basica a mano: Grafana no desafia con 401 (redirige 302 a
    // /login), asi que page.authenticate() de puppeteer -que solo responde a un desafio- nunca
    // se dispara. hay que mandar el header desde el primer request.
    const auth = Buffer.from(`${grafanaUser}:${grafanaPass}`).toString("base64");
    await page.setExtraHTTPHeaders({ Authorization: `Basic ${auth}` });
    await page.setViewport({ width: ANCHO, height: ALTO });

    for (const panel of paneles) {
      const params = new URLSearchParams({
        orgId: "1",
        panelId: String(panel.id),
        from: String(from),
        to: String(to),
        "var-server": prefijo,
        theme: "light",
      });
      // multivalor: hay que repetir la clave, una asignacion con comas no selecciona varios
      for (const c of containers) params.append("var-container", c);
      const url = `${grafanaUrl}/d-solo/${uid}/${slug}?${params}`;
      const archivo = path.join(destino, nombreArchivo(panel));
      process.stdout.write(`Panel ${panel.id} (${panel.title})... `);
      try {
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        await esperarPanel(page);
        await page.screenshot({ path: archivo });
        console.log(`ok -> ${archivo}`);
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Listo. Capturas en ${destino}`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
