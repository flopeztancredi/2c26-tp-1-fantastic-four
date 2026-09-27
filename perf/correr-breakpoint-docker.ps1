# Uso y descripcion: perf/README.md
param(
    [string]$Escenario = "exchange-availability-breakpoint",
    [string]$Nombre = "",
    [int]$MaxTimeWait = 2000,
    [int]$IntervaloSockstat = 5
)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$Compose  = Join-Path $PSScriptRoot "..\docker-compose.yml"
$Corto    = $Escenario -replace '^exchange-availability-', ''
$Prefijo  = "artillery-exchange-$Corto-docker"
if (-not $Nombre) { $Nombre = "$($Corto)_docker" }
$Red      = "exchange_default"
$Api      = "http://localhost:5555"
$Graphite = "http://localhost:8090"

$Rel = "resultados/$(Get-Date -Format 'yyyy-MM-dd')_$Nombre"
$Dir = Join-Path $PSScriptRoot $Rel
if (-not (Test-Path "$Escenario.yaml")) { Write-Host "No existe $Escenario.yaml" -ForegroundColor Red; exit 1 }
if (Test-Path $Dir) {
    Write-Host "Ya existe $Rel. Usa -Nombre para elegir otra carpeta." -ForegroundColor Red
    exit 1
}
New-Item -ItemType Directory $Dir | Out-Null

function Paso($texto) { Write-Host "`n=== $texto" -ForegroundColor Cyan }
function Chequear($que) {
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: $que (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}
function Guardar($archivo, $texto) {
    [IO.File]::WriteAllText((Join-Path $Dir $archivo), $texto, (New-Object Text.UTF8Encoding $false))
}
function Epoch { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function DockerAArchivos($argumentos, $salida, $errores) {
    Start-Process docker -ArgumentList $argumentos -NoNewWindow -Wait `
        -RedirectStandardOutput (Join-Path $Dir $salida) `
        -RedirectStandardError  (Join-Path $Dir $errores)
}

Paso "1/7 Levantando el sistema y reseteando la api"
docker compose -f $Compose up -d
Chequear "docker compose up"
if (docker ps -q -f "name=^exchange-api-2$") {
    Write-Host "Hay mas de una replica de la api. Correr: docker compose -f ..\docker-compose.yml up -d --scale api=1" -ForegroundColor Red
    exit 1
}
docker compose -f $Compose up -d --build --force-recreate api
Chequear "reset de la api"

$lista = $false
for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest "$Api/rates" -UseBasicParsing -TimeoutSec 2 | Out-Null; $lista = $true; break }
    catch { Start-Sleep 1 }
}
if (-not $lista) { Write-Host "La api no responde en $Api/rates" -ForegroundColor Red; exit 1 }

Guardar "cuentas-antes.json" (Invoke-WebRequest "$Api/accounts" -UseBasicParsing).Content
Copy-Item "$Escenario.yaml" $Dir

Paso "2/7 Registrando eventos de api y nginx"
$eventos = Start-Process docker -NoNewWindow -PassThru `
    -ArgumentList @('events', '--filter', 'container=exchange-api-1', '--filter', 'container=exchange-nginx-1',
                    '--format', '"{{.Time}} {{.Actor.Attributes.name}} {{.Action}}"') `
    -RedirectStandardOutput (Join-Path $Dir "eventos-containers.txt") `
    -RedirectStandardError  (Join-Path $Dir "eventos-containers.err.txt")

Paso "3/7 Corriendo artillery en Docker (npm ci + duracion del escenario)"
if (docker ps -aq -f "name=^artillery$") { docker rm -f artillery | Out-Null }

$Inicio = Epoch
Guardar "inicio.txt" "$Inicio"

$registroSockstat = Start-Job -ArgumentList (Join-Path $Dir "sockstat-artillery.txt"), (Join-Path $Dir "red-cliente-artillery.txt"), $IntervaloSockstat -ScriptBlock {
    param($archivo, $archivoRed, $intervalo)
    $utf8 = New-Object Text.UTF8Encoding $false
    $visto = $false
    for ($i = 0; $i -lt 7200; $i++) {
        $existe = docker ps -q -f "name=^artillery$" 2>$null
        if (-not $existe) {
            if ($visto) { break }
            Start-Sleep 1; continue
        }
        if (-not $visto) {
            $visto = $true
            $red = docker exec artillery sh -c 'cd /proc/sys/net/ipv4; grep . ip_local_port_range tcp_tw_reuse tcp_max_tw_buckets tcp_fin_timeout' 2>$null
            [IO.File]::WriteAllText($archivoRed, (($red -join "`n") + "`n"), $utf8)
        }
        $ahora = [DateTimeOffset]::UtcNow
        $datos = docker exec artillery sh -c 'cat /proc/net/sockstat; grep TcpExt: /proc/net/netstat' 2>$null
        if ($datos) {
            $texto = "### " + $ahora.ToUnixTimeSeconds() + " " + $ahora.ToString("yyyy-MM-ddTHH:mm:ssZ") + "`n" + ($datos -join "`n") + "`n"
            [IO.File]::AppendAllText($archivo, $texto, $utf8)
        }
        Start-Sleep $intervalo
    }
}

$sysctls = @("--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1")
if ($MaxTimeWait -gt 0) { $sysctls += @("--sysctl", "net.ipv4.tcp_max_tw_buckets=$MaxTimeWait") }
docker run --rm --name artillery --network $Red @sysctls `
    -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 `
    -v "${PSScriptRoot}:/perf" -v /perf/node_modules -w /perf node:24 `
    sh -c "npm ci --silent && npx artillery run $Escenario.yaml -e docker --output $Rel/reporte-artillery.json 2>&1 | tee $Rel/resultados-artillery.txt"
$salidaArtillery = $LASTEXITCODE

$Fin = Epoch
Guardar "fin.txt" "$Fin"
Stop-Process -Id $eventos.Id -ErrorAction SilentlyContinue
Wait-Job $registroSockstat -Timeout 30 | Out-Null
Remove-Job $registroSockstat -Force

Paso "4/7 Guardando saldos y estado de la api"
try { Guardar "cuentas-despues.json" (Invoke-WebRequest "$Api/accounts" -UseBasicParsing -TimeoutSec 10).Content }
catch { Guardar "cuentas-despues.json" "ERROR: la api no respondio a /accounts: $_" }
$estado = docker inspect -f '{{.State.Status}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Restarts={{.RestartCount}}' exchange-api-1
Guardar "estado-api-despues.txt" ($estado -join "`n")

Paso "5/7 Guardando logs de nginx y api"
DockerAArchivos @('logs', '--since', "$Inicio", 'exchange-nginx-1') "nginx-access.log" "nginx-error.log"
DockerAArchivos @('logs', '--since', "$Inicio", 'exchange-api-1')   "api-stdout.log"   "api-stderr.log"

Paso "6/7 Exportando metricas de graphite"
Start-Sleep 15
$desde = $Inicio - 20
$hasta = $Fin + 30
function ExportarGraphite($archivo, $targets) {
    $q = ($targets | ForEach-Object { "target=" + [uri]::EscapeDataString($_) }) -join "&"
    try { Guardar $archivo (Invoke-WebRequest "$Graphite/render?$q&from=$desde&until=$hasta&format=json" -UseBasicParsing).Content }
    catch { Guardar $archivo "ERROR exportando de graphite: $_" }
}
ExportarGraphite "datos-recursos.json" @(
    "stats.gauges.cadvisor.{exchange-api-1,exchange-nginx-1,artillery}.cpu_cumulative_usage",
    "stats.gauges.cadvisor.{exchange-api-1,exchange-nginx-1,artillery}.memory_working_set"
)
ExportarGraphite "datos-artillery-graphite.json" @("stats.gauges.$Prefijo.*", "stats.gauges.$Prefijo.*.*")

Paso "7/7 Registrando el entorno"
& {
    Get-CimInstance Win32_Processor | Format-List Name, NumberOfCores, NumberOfLogicalProcessors
    Get-CimInstance Win32_ComputerSystem | Format-List TotalPhysicalMemory
    docker version --format "Engine {{.Server.Version}}"
    docker compose version
    docker info --format "VM: {{.NCPU}} CPU, {{.MemTotal}} bytes, kernel {{.KernelVersion}}"
    docker run --rm alpine free -m
    docker inspect -f "Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}" exchange-api-1
} | Out-String | ForEach-Object { Guardar "entorno.txt" $_ }

Paso "Listo"
if ($salidaArtillery -ne 0) { Write-Host "Ojo: artillery termino con exit $salidaArtillery" -ForegroundColor Yellow }
$ev = Get-Content (Join-Path $Dir "eventos-containers.txt") -ErrorAction SilentlyContinue
Write-Host "Resultados en: perf/$Rel"
Write-Host "Eventos de containers: $(if ($ev) { $ev -join ' | ' } else { 'ninguno' })"
Write-Host "Estado de la api: $estado"
Write-Host "Grafana: prefijo $Prefijo, containers exchange-api-1 / exchange-nginx-1 / artillery,"
Write-Host "         desde $([DateTimeOffset]::FromUnixTimeSeconds($Inicio).ToLocalTime().ToString('HH:mm')) hasta $([DateTimeOffset]::FromUnixTimeSeconds($Fin).ToLocalTime().ToString('HH:mm'))"
