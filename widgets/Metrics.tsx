import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { Astal } from "ags/gtk4"

import { createComputed, createState, For } from "ags"
import { METRICS_OVERRIDE } from "../config"
import { FLOATING_POPUP_ANCHOR, isPointInsideWidget, placePopupFromTrigger } from "./FloatingPopup"
import { createPoll } from "ags/time"


type MetricId =
  | "cpufreq"
  | "cpu"
  | "memory"
  | "ramtemp"
  | "swap"
  | "loadavg"
  | "uptime"
  | "network"
  | "temperature"
  | "fan"

type MetricSpec = {
  id: MetricId
  icon: string
  title: string
  description: string
  interval: number
  fallback: string
  poll: () => string
  available?: () => boolean
}

type TemperatureSource = {
  path: string
  label: string
  score: number
}

type FanSource = {
  path: string
  label: string
}

type ManualSource = {
  path: string
  label: string
}

type SourceSelectionState = {
  networkInterface: string
  cpuFreqPath: string
  temperatureSensorPath: string
  memoryTemperatureSensorPaths: string[]
  fanSensorPath: string
}

type SourceOption = {
  value: string
  label: string
  meta: string
}

const decoder = new TextDecoder()
const METRIC_STATE_PATH = `${GLib.get_user_config_dir()}/ags/metric-picker.json`
const SOURCE_STATE_PATH = `${GLib.get_user_config_dir()}/ags/metric-sources.json`
const DEFAULT_METRICS: MetricId[] = ["cpufreq", "cpu", "memory", "ramtemp"]
const METRIC_PICKER_POPOVER_REVEAL_DURATION_MS = 340
const METRIC_PICKER_POPOVER_OFFSET_Y = 20
const METRIC_SOURCES_REVEAL_DURATION_MS = 220
const EMPTY_SOURCE_SELECTION: SourceSelectionState = {
  networkInterface: "",
  cpuFreqPath: "",
  temperatureSensorPath: "",
  memoryTemperatureSensorPaths: [],
  fanSensorPath: "",
}

function decodeText(data: string | Uint8Array | null | undefined) {
  if (!data) return ""
  if (typeof data === "string") return data
  return decoder.decode(data)
}

function readText(path: string) {
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    return ok ? decodeText(contents).trim() : ""
  } catch {
    return ""
  }
}

function readNumber(path: string) {
  const value = Number.parseFloat(readText(path))
  return Number.isFinite(value) ? value : 0
}

function pathExists(path: string) {
  return GLib.file_test(path, GLib.FileTest.EXISTS)
}

function dirExists(path: string) {
  return GLib.file_test(path, GLib.FileTest.IS_DIR)
}

function isReadableFile(path: string) {
  return GLib.file_test(path, GLib.FileTest.EXISTS | GLib.FileTest.IS_REGULAR)
}

function normalizeConfiguredPath(path: string | null | undefined) {
  const value = `${path ?? ""}`.trim()
  return value.length > 0 ? value : ""
}

function resolveConfiguredSource(path: string | null | undefined, fallbackLabel: string): ManualSource | null {
  const normalized = normalizeConfiguredPath(path)
  if (!normalized || !isReadableFile(normalized)) return null

  return {
    path: normalized,
    label: fallbackLabel,
  }
}

function sanitizeSourceSelection(value: unknown): SourceSelectionState {
  if (!value || typeof value !== "object") return { ...EMPTY_SOURCE_SELECTION }

  const data = value as Partial<SourceSelectionState>

  return {
    networkInterface: normalizeConfiguredPath(data.networkInterface),
    cpuFreqPath: normalizeConfiguredPath(data.cpuFreqPath),
    temperatureSensorPath: normalizeConfiguredPath(data.temperatureSensorPath),
    memoryTemperatureSensorPaths: Array.isArray(data.memoryTemperatureSensorPaths)
      ? data.memoryTemperatureSensorPaths.map((path) => normalizeConfiguredPath(path)).filter(Boolean)
      : [],
    fanSensorPath: normalizeConfiguredPath(data.fanSensorPath),
  }
}

function loadSourceSelection() {
  try {
    return sanitizeSourceSelection(JSON.parse(readText(SOURCE_STATE_PATH) || "null"))
  } catch {
    return { ...EMPTY_SOURCE_SELECTION }
  }
}

function saveSourceSelection(selection: SourceSelectionState) {
  try {
    GLib.mkdir_with_parents(`${GLib.get_user_config_dir()}/ags`, 0o755)
    GLib.file_set_contents(SOURCE_STATE_PATH, JSON.stringify(selection))
  } catch (error) {
    console.error(error)
  }
}

function listDir(path: string) {
  if (!dirExists(path)) return []

  try {
    const dir = Gio.File.new_for_path(path)
    const enumerator = dir.enumerate_children(
      "standard::name,standard::type",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )

    const items: string[] = []
    while (true) {
      const info = enumerator.next_file(null)
      if (!info) break
      items.push(info.get_name())
    }

    enumerator.close(null)
    return items.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

function formatGiBFromKiB(valueKiB: number) {
  const gib = valueKiB / 1024 / 1024
  if (gib >= 100) return `${Math.round(gib)}G`
  if (gib >= 10) return `${gib.toFixed(0)}G`
  return `${gib.toFixed(1)}G`
}

function formatGHzFromKHz(valueKHz: number) {
  if (valueKHz <= 0) return "--GHz"
  return `${(valueKHz / 1_000_000).toFixed(2)}GHz`
}

function formatGHzFromMHz(valueMHz: number) {
  if (valueMHz <= 0) return "--GHz"
  return `${(valueMHz / 1000).toFixed(2)}GHz`
}

function formatUptime(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--"

  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  return `${minutes}m`
}

function formatBytesPerSecond(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "--"
  if (bytesPerSecond >= 1024 ** 3) return `${(bytesPerSecond / 1024 ** 3).toFixed(1)}G`
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(1)}M`
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)}K`
  return `${Math.round(bytesPerSecond)}B`
}

function formatTemperature(valueMilliC: number) {
  if (!Number.isFinite(valueMilliC) || valueMilliC <= 0) return "--°C"
  const celsius = valueMilliC >= 1000 ? valueMilliC / 1000 : valueMilliC
  return `${Math.round(celsius)}°C`
}

function formatRpm(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 RPM"
  return `${Math.round(value)} RPM`
}

function parseMeminfo() {
  const raw = readText("/proc/meminfo")
  const values = new Map<string, number>()

  for (const line of raw.split("\n")) {
    const match = line.match(/^([^:]+):\s+(\d+)/)
    if (!match) continue
    values.set(match[1], Number.parseInt(match[2], 10))
  }

  return values
}

function readRouteInterface() {
  const lines = readText("/proc/net/route").split("\n")

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue

    const iface = parts[0]
    const destination = parts[1]
    const flags = Number.parseInt(parts[3], 16)

    if (destination === "00000000" && Number.isFinite(flags) && (flags & 0x2) !== 0) {
      return iface
    }
  }

  return ""
}

function listNetworkInterfaces() {
  return listDir("/sys/class/net")
    .filter((name) => name !== "lo")
    .filter((name) => pathExists(`/sys/class/net/${name}/statistics/rx_bytes`))
}

let sourceSelectionCache = loadSourceSelection()

function getOverrideNetworkInterface() {
  return normalizeConfiguredPath(sourceSelectionCache.networkInterface)
    || normalizeConfiguredPath(METRICS_OVERRIDE.networkInterface)
}

function getOverrideCpuFreqPath() {
  return normalizeConfiguredPath(sourceSelectionCache.cpuFreqPath)
    || normalizeConfiguredPath(METRICS_OVERRIDE.cpuFreqPath)
}

function getOverrideTemperaturePath() {
  return normalizeConfiguredPath(sourceSelectionCache.temperatureSensorPath)
    || normalizeConfiguredPath(METRICS_OVERRIDE.temperatureSensorPath)
}

function getOverrideMemoryTemperaturePaths() {
  const selected = (sourceSelectionCache.memoryTemperatureSensorPaths ?? [])
    .map((path) => normalizeConfiguredPath(path))
    .filter(Boolean)

  if (selected.length > 0) return selected

  return (METRICS_OVERRIDE.memoryTemperatureSensorPaths ?? [])
    .map((path) => normalizeConfiguredPath(path))
    .filter(Boolean)
}

function getOverrideFanPath() {
  return normalizeConfiguredPath(sourceSelectionCache.fanSensorPath)
    || normalizeConfiguredPath(METRICS_OVERRIDE.fanSensorPath)
}

function listCpuFreqCandidatePaths() {
  const configured = getOverrideCpuFreqPath()
  const candidates = [
    ...(configured ? [configured] : []),
    "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq",
    "/sys/devices/system/cpu/cpufreq/policy0/cpuinfo_cur_freq",
    "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",
    "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq",
  ]

  return [...new Set(candidates.filter((path) => isReadableFile(path)))]
}

function pickNetworkInterface() {
  const names = listNetworkInterfaces()
  if (names.length === 0) return ""

  const configured = getOverrideNetworkInterface()
  if (configured && names.includes(configured)) return configured

  const routeIface = readRouteInterface()
  if (routeIface && names.includes(routeIface)) return routeIface

  const activeIface = names.find((name) => {
    const operstate = readText(`/sys/class/net/${name}/operstate`)
    return operstate === "up" || operstate === "unknown"
  })

  return activeIface ?? names[0] ?? ""
}

function collectTemperatureSources() {
  const sources: TemperatureSource[] = []

  for (const hwmon of listDir("/sys/class/hwmon")) {
    const base = `/sys/class/hwmon/${hwmon}`
    const chip = readText(`${base}/name`)

    for (const entry of listDir(base)) {
      const match = entry.match(/^(temp\d+)_input$/)
      if (!match) continue

      const stem = match[1]
      const path = `${base}/${entry}`
      const value = readNumber(path)
      if (value <= 0) continue

      const label = readText(`${base}/${stem}_label`) || chip || hwmon
      const haystack = `${label} ${chip}`.toLowerCase()
      let score = 10

      if (/package|tdie|tctl|cpu|coretemp|k10temp|x86_pkg_temp/.test(haystack)) score += 30
      else if (/edge|soc|acpitz|pch/.test(haystack)) score += 20

      if (value >= 10_000 && value <= 120_000) score += 10

      sources.push({ path, label: label || "Temperature", score })
    }
  }

  for (const zone of listDir("/sys/class/thermal")) {
    if (!zone.startsWith("thermal_zone")) continue

    const base = `/sys/class/thermal/${zone}`
    const path = `${base}/temp`
    const value = readNumber(path)
    if (value <= 0) continue

    const type = readText(`${base}/type`) || zone
    const haystack = type.toLowerCase()
    let score = 5

    if (/package|cpu|x86_pkg_temp/.test(haystack)) score += 30
    else if (/soc|acpitz|thermal/.test(haystack)) score += 15

    if (value >= 10_000 && value <= 120_000) score += 10

    sources.push({ path, label: type, score })
  }

  return sources.sort((a, b) => b.score - a.score)
}

function pickTemperatureSource() {
  const configured = resolveConfiguredSource(getOverrideTemperaturePath(), "Selected temperature sensor")
  if (configured) {
    return {
      path: configured.path,
      label: configured.label,
      score: Number.MAX_SAFE_INTEGER,
    }
  }

  return collectTemperatureSources()[0] ?? null
}

function collectDetectedMemoryTemperatureSources() {
  const sources: TemperatureSource[] = []

  for (const hwmon of listDir("/sys/class/hwmon")) {
    const base = `/sys/class/hwmon/${hwmon}`
    const chip = readText(`${base}/name`)

    for (const entry of listDir(base)) {
      const match = entry.match(/^(temp\d+)_input$/)
      if (!match) continue

      const stem = match[1]
      const path = `${base}/${entry}`
      const value = readNumber(path)
      if (value <= 0) continue

      const label = readText(`${base}/${stem}_label`) || chip || hwmon
      const haystack = `${label} ${chip} ${hwmon}`.toLowerCase()
      let score = 0

      const hasStrongRamSignal = /spd5118|jc42|dimmtemp|sodimm|dimm|dram|ddr\d*|lpddr/.test(haystack)
      const hasWeakRamSignal = /(^|[^a-z])(ram|memory|mem)([^a-z]|$)/.test(haystack)
      const looksLikeGpuOrNonRam = /gpu|vram|video|gddr|hbm|amdgpu|radeon|nvidia|nouveau|i915|xe|intelgpu|intel_gpu|junction|edge|package|cpu|coretemp|k10temp|soc|pch|acpitz|composite|nvme|ssd/.test(haystack)

      if (hasStrongRamSignal) score += 100
      if (hasWeakRamSignal) score += 25
      if (/spd/.test(haystack)) score += 20
      if (value >= 10_000 && value <= 110_000) score += 10
      if (looksLikeGpuOrNonRam) score -= 200

      if (score >= 80) {
        sources.push({ path, label: label || "RAM", score })
      }
    }
  }

  return sources.sort((a, b) => b.score - a.score)
}

function collectMemoryTemperatureSources() {
  const configured = getOverrideMemoryTemperaturePaths()
    .map((path, index) => resolveConfiguredSource(path, `Selected RAM sensor ${index + 1}`))
    .filter((source): source is ManualSource => Boolean(source))
    .map((source) => ({
      path: source.path,
      label: source.label,
      score: Number.MAX_SAFE_INTEGER,
    }))

  if (configured.length > 0) return configured
  return collectDetectedMemoryTemperatureSources()
}

function collectFanSources() {
  const sources: FanSource[] = []

  for (const hwmon of listDir("/sys/class/hwmon")) {
    const base = `/sys/class/hwmon/${hwmon}`
    const chip = readText(`${base}/name`)

    for (const entry of listDir(base)) {
      const match = entry.match(/^(fan\d+)_input$/)
      if (!match) continue

      const stem = match[1]
      const path = `${base}/${entry}`
      const label = readText(`${base}/${stem}_label`) || chip || `${hwmon} fan`
      sources.push({ path, label: label || "Fan" })
    }
  }

  return sources
}

function pickFanSource() {
  const configured = resolveConfiguredSource(getOverrideFanPath(), "Selected fan sensor")
  if (configured) {
    return {
      path: configured.path,
      label: configured.label,
    }
  }

  return collectFanSources()[0] ?? null
}

function getTemperatureSource() {
  return pickTemperatureSource()
}

function getMemoryTemperatureSources() {
  return collectMemoryTemperatureSources()
}

function getFanSource() {
  return pickFanSource()
}

const cpuUsage = (() => {
  let previousIdle = 0
  let previousTotal = 0

  return () => {
    const firstLine = readText("/proc/stat").split("\n")[0] ?? ""
    const parts = firstLine.split(/\s+/).slice(1).map((value) => Number.parseInt(value, 10))

    if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) {
      return "--%"
    }

    const idle = (parts[3] ?? 0) + (parts[4] ?? 0)
    const total = parts.reduce((sum, value) => sum + value, 0)

    if (previousTotal === 0 || total <= previousTotal) {
      previousIdle = idle
      previousTotal = total
      return "0%"
    }

    const idleDelta = idle - previousIdle
    const totalDelta = total - previousTotal

    previousIdle = idle
    previousTotal = total

    if (totalDelta <= 0) return "--%"

    const usage = clampPercent(((totalDelta - idleDelta) / totalDelta) * 100)
    return `${Math.round(usage)}%`
  }
})()

const networkSpeedLabel = (() => {
  let previousIface = ""
  let previousRx = 0
  let previousTx = 0
  let previousTime = 0

  return () => {
    const iface = pickNetworkInterface()
    if (!iface) return "--"

    const rx = readNumber(`/sys/class/net/${iface}/statistics/rx_bytes`)
    const tx = readNumber(`/sys/class/net/${iface}/statistics/tx_bytes`)
    const now = GLib.get_monotonic_time() / 1_000_000

    if (iface !== previousIface || previousTime <= 0 || now <= previousTime) {
      previousIface = iface
      previousRx = rx
      previousTx = tx
      previousTime = now
      return "↓0B ↑0B"
    }

    const seconds = now - previousTime
    const rxRate = Math.max(0, (rx - previousRx) / seconds)
    const txRate = Math.max(0, (tx - previousTx) / seconds)

    previousIface = iface
    previousRx = rx
    previousTx = tx
    previousTime = now

    return `↓${formatBytesPerSecond(rxRate)} ↑${formatBytesPerSecond(txRate)}`
  }
})()

function cpuFreqLabel() {
  for (const path of listCpuFreqCandidatePaths()) {
    const value = readNumber(path)
    if (value > 0) return `${formatGHzFromKHz(value)}`
  }

  const matches = [...readText("/proc/cpuinfo").matchAll(/cpu MHz\s*:\s*([0-9.]+)/g)]
    .map((match) => Number.parseFloat(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0)

  if (matches.length > 0) {
    return `${formatGHzFromMHz(Math.max(...matches))}`
  }

  return "--GHz"
}

function memoryLabel() {
  const info = parseMeminfo()
  const total = info.get("MemTotal") ?? 0
  const available = info.get("MemAvailable") ?? info.get("MemFree") ?? 0
  const used = Math.max(0, total - available)

  if (total <= 0) return "--"
  return `${formatGiBFromKiB(used)}/${formatGiBFromKiB(total)}`
}

function swapLabel() {
  const info = parseMeminfo()
  const total = info.get("SwapTotal") ?? 0
  const free = info.get("SwapFree") ?? 0
  const used = Math.max(0, total - free)

  if (total <= 0) return "off"
  return `${formatGiBFromKiB(used)}/${formatGiBFromKiB(total)}`
}

function loadavgLabel() {
  const first = readText("/proc/loadavg").split(/\s+/)[0] ?? ""
  const value = Number.parseFloat(first)
  return Number.isFinite(value) ? `${value.toFixed(2)}` : "--"
}

function uptimeLabel() {
  const first = readText("/proc/uptime").split(/\s+/)[0] ?? ""
  const seconds = Number.parseFloat(first)
  return `${formatUptime(seconds)}`
}

function temperatureLabel() {
  const source = getTemperatureSource()
  if (!source) return "--°C"
  return `${formatTemperature(readNumber(source.path))}`
}

function memoryTemperatureLabel() {
  const sources = getMemoryTemperatureSources()

  if (sources.length === 0) return "--°C"

  const hottest = sources.reduce((best, source) => {
    const bestValue = readNumber(best.path)
    const nextValue = readNumber(source.path)
    return nextValue > bestValue ? source : best
  })

  return `${formatTemperature(readNumber(hottest.path))}`
}

function fanLabel() {
  const source = getFanSource()
  if (!source) return "0 RPM"
  return `${formatRpm(readNumber(source.path))}`
}

const ALL_METRICS: MetricSpec[] = [
  {
    id: "cpufreq",
    icon: "󰓅",
    title: "CPU Frequency",
    description: "Current effective CPU frequency (config override supported)",
    interval: 2000,
    fallback: "--GHz",
    poll: cpuFreqLabel,
  },
  {
    id: "cpu",
    icon: "󰍛",
    title: "CPU Usage",
    description: "Average load across all cores",
    interval: 2000,
    fallback: "--%",
    poll: cpuUsage,
  },
  {
    id: "memory",
    icon: "󰆼",
    title: "Memory",
    description: "Used and total system RAM",
    interval: 3000,
    fallback: "--",
    poll: memoryLabel,
  },
  {
    id: "ramtemp",
    icon: "󰆼",
    title: "RAM Temperature",
    description: "High-confidence DIMM/SPD sensor only (or manually selected paths)",
    interval: 3000,
    fallback: "--°C",
    poll: memoryTemperatureLabel,
    available: () => getMemoryTemperatureSources().length > 0,
  },
  {
    id: "swap",
    icon: "󰓡",
    title: "Swap",
    description: "Swap usage",
    interval: 4000,
    fallback: "off",
    poll: swapLabel,
  },
  {
    id: "loadavg",
    icon: "󰄪",
    title: "Load Average",
    description: "1-minute system load average",
    interval: 3000,
    fallback: "--",
    poll: loadavgLabel,
  },
  {
    id: "uptime",
    icon: "󰅐",
    title: "Uptime",
    description: "Time since last boot",
    interval: 15000,
    fallback: "--",
    poll: uptimeLabel,
  },
  {
    id: "network",
    icon: "󰌘",
    title: "Network Speed",
    description: "Live download and upload throughput (config override supported)",
    interval: 2000,
    fallback: "↓0B ↑0B",
    poll: networkSpeedLabel,
    available: () => pickNetworkInterface().length > 0,
  },
  {
    id: "temperature",
    icon: "󰔏",
    title: "Temperature",
    description: "Best available system temperature sensor (or configured path)",
    interval: 3000,
    fallback: "--°C",
    poll: temperatureLabel,
    available: () => Boolean(getTemperatureSource()),
  },
  {
    id: "fan",
    icon: "󰈐",
    title: "Fan Speed",
    description: "Best available fan RPM sensor (or configured path)",
    interval: 3000,
    fallback: "0 RPM",
    poll: fanLabel,
    available: () => Boolean(getFanSource()),
  },
]

const AVAILABLE_METRICS = ALL_METRICS.filter((metric) => {
  try {
    return metric.available ? metric.available() : true
  } catch {
    return false
  }
})

function sanitizeMetricIds(ids: string[]) {
  const available = new Set(AVAILABLE_METRICS.map((metric) => metric.id))
  const unique = ids.filter((id): id is MetricId => available.has(id as MetricId))
  return [...new Set(unique)]
}

function loadMetricSelection() {
  try {
    const parsed = JSON.parse(readText(METRIC_STATE_PATH) || "null")
    if (!Array.isArray(parsed)) return sanitizeMetricIds(DEFAULT_METRICS)
    const sanitized = sanitizeMetricIds(parsed)
    return sanitized.length > 0 ? sanitized : []
  } catch {
    return sanitizeMetricIds(DEFAULT_METRICS)
  }
}

function saveMetricSelection(ids: MetricId[]) {
  try {
    GLib.mkdir_with_parents(`${GLib.get_user_config_dir()}/ags`, 0o755)
    GLib.file_set_contents(METRIC_STATE_PATH, JSON.stringify(ids))
  } catch (error) {
    console.error(error)
  }
}

function trimPath(path: string, max = 52) {
  if (path.length <= max) return path
  return `…${path.slice(-(max - 1))}`
}

function buildNetworkOptions(): SourceOption[] {
  const routeIface = readRouteInterface()
  const seen = new Set<string>()
  const candidates = listNetworkInterfaces()
  const options: SourceOption[] = [{
    value: "",
    label: "Auto",
    meta: routeIface ? `default route → ${routeIface}` : candidates[0] ? `fallback → ${candidates[0]}` : "No interface found",
  }]

  for (const name of candidates) {
    if (seen.has(name)) continue
    seen.add(name)

    const operstate = readText(`/sys/class/net/${name}/operstate`) || "unknown"
    options.push({
      value: name,
      label: name,
      meta: `operstate: ${operstate}`,
    })
  }

  return options
}

function buildCpuFreqOptions(): SourceOption[] {
  const candidates = listCpuFreqCandidatePaths()
  const options: SourceOption[] = [{
    value: "",
    label: "Auto",
    meta: candidates[0] ? trimPath(candidates[0]) : "/proc/cpuinfo fallback",
  }]

  for (const path of candidates) {
    options.push({
      value: path,
      label: path.split("/").slice(-2).join("/"),
      meta: trimPath(path),
    })
  }

  return options
}

function buildTemperatureOptions(): SourceOption[] {
  const detected = collectTemperatureSources()
  const autoChoice = detected[0] ?? null
  const options: SourceOption[] = [{
    value: "",
    label: "Auto",
    meta: autoChoice ? `${autoChoice.label} • ${trimPath(autoChoice.path)}` : "No sensor found",
  }]

  for (const source of detected) {
    options.push({
      value: source.path,
      label: source.label,
      meta: trimPath(source.path),
    })
  }

  return options
}

function buildMemoryTemperatureOptions(): SourceOption[] {
  const detected = collectDetectedMemoryTemperatureSources()
  const autoChoice = detected[0] ?? null
  const options: SourceOption[] = [{
    value: "",
    label: "Auto",
    meta: autoChoice ? `${autoChoice.label} • high-confidence DIMM/SPD sensor` : "No RAM sensor found",
  }]

  for (const source of detected) {
    options.push({
      value: source.path,
      label: source.label,
      meta: trimPath(source.path),
    })
  }

  return options
}

function buildFanOptions(): SourceOption[] {
  const detected = collectFanSources()
  const autoChoice = detected[0] ?? null
  const options: SourceOption[] = [{
    value: "",
    label: "Auto",
    meta: autoChoice ? `${autoChoice.label} • ${trimPath(autoChoice.path)}` : "No fan sensor found",
  }]

  for (const source of detected) {
    options.push({
      value: source.path,
      label: source.label,
      meta: trimPath(source.path),
    })
  }

  return options
}

function SourceSelectorRow({
  title,
  selectedValue,
  options,
  onSelect,
}: {
  title: string
  selectedValue: () => string
  options: () => SourceOption[]
  onSelect: (value: string) => void
}) {
  const currentOption = createComputed(() => {
    const items = options()
    return items.find((item) => item.value === selectedValue()) ?? items[0] ?? null
  })

  const hasMultipleChoices = createComputed(() => options().length > 1)

  const pickNext = () => {
    const items = options()
    if (items.length <= 1) return

    const currentIndex = items.findIndex((item) => item.value === selectedValue())
    const nextIndex = currentIndex < 0 || currentIndex + 1 >= items.length ? 0 : currentIndex + 1
    onSelect(items[nextIndex]?.value ?? "")
  }

  return (
    <box class="metric-source-row" spacing={8} hexpand valign={Gtk.Align.CENTER}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
        <label class="metric-source-title" xalign={0} label={title} />
        <label
          class="metric-source-label"
          xalign={0}
          wrap
          tooltipText={currentOption((option) => option?.meta ?? "")}
          label={currentOption((option) => option ? `${option.label} • ${option.meta}` : "No candidates")}
        />
      </box>

      <box class="metric-source-actions" spacing={6} valign={Gtk.Align.CENTER}>
        <button
          class="flat metric-source-action"
          tooltipText="Reset to autodetect"
          onClicked={() => onSelect("")}
          sensitive={createComputed(() => selectedValue().length > 0)}
        >
          <label label="Auto" />
        </button>

        <button
          class="flat metric-source-action"
          tooltipText="Cycle through detected sources"
          onClicked={pickNext}
          sensitive={hasMultipleChoices}
        >
          <label label="Next" />
        </button>
      </box>
    </box>
  )
}

function MetricChip({ spec }: { spec: MetricSpec }) {
  const value = createPoll(spec.fallback, spec.interval, () => {
    try {
      return spec.poll()
    } catch {
      return spec.fallback
    }
  })

  return (
    <box class="metric-chip" spacing={5} valign={Gtk.Align.CENTER}>
      <label class="metric-chip-icon" label={spec.icon} />
      <label class="metric-chip-value" label={value} />
    </box>
  )
}

function MetricOption({
  spec,
  selected,
  setSelected,
}: {
  spec: MetricSpec
  selected: () => MetricId[]
  setSelected: (value: MetricId[] | ((current: MetricId[]) => MetricId[])) => MetricId[]
}) {
  const enabled = createComputed(() => selected().includes(spec.id))
  const meta = createComputed(
    () => `${spec.description} • ${enabled() ? "enabled" : "hidden"}`,
  )

  const toggle = () => {
    setSelected((current) => {
      const next = current.includes(spec.id)
        ? current.filter((id) => id !== spec.id)
        : [...current, spec.id]

      const normalized = AVAILABLE_METRICS
        .map((metric) => metric.id)
        .filter((id) => next.includes(id))

      saveMetricSelection(normalized)
      return normalized
    })
  }

  return (
    <button
      class={enabled((active) => active
        ? "flat metric-option-button metric-option-button-active"
        : "flat metric-option-button")}
      onClicked={toggle}
      tooltipText={spec.title}
    >
      <box class="metric-option-body" spacing={10} hexpand valign={Gtk.Align.CENTER}>
        <label class="metric-option-icon" label={spec.icon} />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
          <label class="metric-option-title" xalign={0} label={spec.title} />
          <label class="metric-option-meta" xalign={0} label={meta} />
        </box>

        <label
          class={enabled((active) => active
            ? "metric-option-status metric-option-status-active"
            : "metric-option-status")}
          label={enabled((active) => active ? "󰗠" : "󰄰")}
        />
      </box>
    </button>
  )
}

export function MetricsMenu({ monitor }: { monitor: number }) {
  let trigger: Gtk.Button | null = null
  let popupPlacement: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)

  const [selected, setSelected] = createState<MetricId[]>(loadMetricSelection())
  const [sourceSelection, setSourceSelection] = createState<SourceSelectionState>({ ...sourceSelectionCache })
  const [sourcesExpanded, setSourcesExpanded] = createState(false)
  const selectedMetrics = createComputed(() => AVAILABLE_METRICS.filter((metric) => selected().includes(metric.id)))
  const hasMetrics = createComputed(() => selectedMetrics().length > 0)
  const triggerClass = createComputed(() => hasMetrics()
    ? "metric-picker-trigger metric-picker-trigger-filled left-module-button"
    : "metric-picker-trigger metric-picker-trigger-empty left-module-button")

  const updateSourceSelection = (
    patch: Partial<SourceSelectionState> | ((current: SourceSelectionState) => SourceSelectionState),
  ) => {
    setSourceSelection((current) => {
      const next = sanitizeSourceSelection(typeof patch === "function" ? patch(current) : { ...current, ...patch })
      sourceSelectionCache = next
      saveSourceSelection(next)
      return next
    })
  }

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
  }

  const syncPopupPosition = () => {
    placePopupFromTrigger(trigger, popupPlacement, popupFrame, {
      offsetY: METRIC_PICKER_POPOVER_OFFSET_Y,
      align: "center",
    })
  }

  const syncPopupPositionSoon = () => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      syncPopupPosition()
      return GLib.SOURCE_REMOVE
    })
  }

  const toggleSourcesExpanded = () => {
    setSourcesExpanded((current) => {
      const next = !current
      syncPopupPositionSoon()
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, METRIC_SOURCES_REVEAL_DURATION_MS + 30, () => {
        syncPopupPosition()
        return GLib.SOURCE_REMOVE
      })
      return next
    })
  }

  const finishClosePopup = () => {
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const closePopup = () => {
    if (closingPopup || !windowVisible()) return

    closingPopup = true

    if (popupRevealer?.get_reveal_child()) {
      popupRevealer.revealChild = false
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, METRIC_PICKER_POPOVER_REVEAL_DURATION_MS, () => {
        finishClosePopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishClosePopup()
  }

  const openPopup = () => {
    if (windowVisible()) {
      syncPopupPosition()
      return
    }

    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (windowVisible()) closePopup()
    else openPopup()
  }

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      namespace={`metrics-popup-${monitor}`}
      class="widget-popup-window metric-picker-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={FLOATING_POPUP_ANCHOR}
    >
      <box class="widget-popup-root" hexpand vexpand>
        <Gtk.GestureClick
          button={0}
          onPressed={(_, _nPress, x, y) => {
            const root = popupPlacement?.get_parent?.() as Gtk.Widget | null
            if (isPointInsideWidget(popupFrame, root, x, y)) return
            closePopup()
          }}
        />

        <box
          class="widget-popup-placement"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          $={(self) => (popupPlacement = self)}
        >

          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.CROSSFADE}
            transitionDuration={METRIC_PICKER_POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame metric-picker-popover-window" $={(self) => (popupFrame = self)}>
              <box class="metric-picker-popover" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                <box class="metric-picker-header" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                  <label class="metric-picker-title" xalign={0} label="Metrics" />
                  <label
                    class="metric-picker-subtitle"
                    xalign={0}
                    label={hasMetrics((value) => value ? "Pick what to monitor" : "No metrics enabled")}
                  />
                </box>

                <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                  {AVAILABLE_METRICS.map((spec) => (
                    <MetricOption
                      spec={spec}
                      selected={selected}
                      setSelected={setSelected}
                    />
                  ))}
                </box>

                <box class="metric-picker-divider" />

                <button
                  class={sourcesExpanded((open) => open
                    ? "flat metric-section-toggle metric-section-toggle-open"
                    : "flat metric-section-toggle")}
                  onClicked={toggleSourcesExpanded}
                >
                  <box class="metric-section-toggle-body" spacing={10} hexpand valign={Gtk.Align.CENTER}>
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
                      <label class="metric-picker-title" xalign={0} label="Sources" />
                      <label
                        class="metric-picker-subtitle"
                        xalign={0}
                        label={sourcesExpanded((open) => open
                          ? "Manual source selection is open"
                          : "Autodetect by default. Click to override sensors")}
                      />
                    </box>

                    <label
                      class="metric-section-toggle-icon"
                      label={sourcesExpanded((open) => open ? "󰅀" : "󰅂")}
                    />
                  </box>
                </button>

                <revealer
                  class="metric-sources-revealer"
                  revealChild={sourcesExpanded}
                  transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                  transitionDuration={METRIC_SOURCES_REVEAL_DURATION_MS}
                >
                  <box class="metric-sources-list" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    <SourceSelectorRow
                      title="Network interface"
                      selectedValue={() => sourceSelection().networkInterface}
                      options={buildNetworkOptions}
                      onSelect={(value) => updateSourceSelection({ networkInterface: value })}
                    />

                    <SourceSelectorRow
                      title="CPU frequency source"
                      selectedValue={() => sourceSelection().cpuFreqPath}
                      options={buildCpuFreqOptions}
                      onSelect={(value) => updateSourceSelection({ cpuFreqPath: value })}
                    />

                    <SourceSelectorRow
                      title="Temperature sensor"
                      selectedValue={() => sourceSelection().temperatureSensorPath}
                      options={buildTemperatureOptions}
                      onSelect={(value) => updateSourceSelection({ temperatureSensorPath: value })}
                    />

                    <SourceSelectorRow
                      title="RAM temperature sensor"
                      selectedValue={() => sourceSelection().memoryTemperatureSensorPaths[0] ?? ""}
                      options={buildMemoryTemperatureOptions}
                      onSelect={(value) => updateSourceSelection({ memoryTemperatureSensorPaths: value ? [value] : [] })}
                    />

                    <SourceSelectorRow
                      title="Fan sensor"
                      selectedValue={() => sourceSelection().fanSensorPath}
                      options={buildFanOptions}
                      onSelect={(value) => updateSourceSelection({ fanSensorPath: value })}
                    />
                  </box>
                </revealer>
              </box>
            </box>
          </revealer>
        </box>
      </box>
    </window>
  )

  void popupWindow

  return (
    <button
      class={triggerClass}
      tooltipText="Choose metrics"
      onClicked={togglePopup}
      $={(self) => {
        trigger = self

        self.connect("destroy", () => {
          clearCloseTimeout()
          closingPopup = false
          setWindowVisible(false)
        })
      }}
    >
      <box class="metrics-shell left-module-content" spacing={0} valign={Gtk.Align.CENTER}>
        <box
          class="metric-picker-empty-wrap"
          visible={hasMetrics((value) => !value)}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        >
          <label
            class="module-icon metric-picker-icon"
            xalign={0.5}
            label={"󰍉"}
          />
        </box>

        <box class="metrics-inline" visible={hasMetrics} spacing={0} valign={Gtk.Align.CENTER}>
          <For each={selectedMetrics}>
            {(spec) => <MetricChip spec={spec} />}
          </For>
        </box>
      </box>
    </button>
  )
}
