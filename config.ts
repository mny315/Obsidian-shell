export const BRIGHTNESS_MIN = 0.05
export const BRIGHTNESS_STEP = 0.05
export const VOLUME_STEP = 0.05
export const WIDGET_AUTO_CLOSE_DELAY_MS = 5000
export const REVEALER_HIDE_DELAY_MS = WIDGET_AUTO_CLOSE_DELAY_MS

export const fallback = {
  clock: "--:--",
} as const

export function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v))
}

export const METRICS_OVERRIDE = {
  // Example: "wlp2s0"
  networkInterface: "",

  // Example:
  // "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq"
  cpuFreqPath: "",

  // Example:
  // "/sys/class/hwmon/hwmon3/temp1_input"
  temperatureSensorPath: "",

  // Example:
  // [
  //   "/sys/class/hwmon/hwmon8/temp1_input",
  //   "/sys/class/hwmon/hwmon9/temp1_input",
  // ]
  memoryTemperatureSensorPaths: [] as string[],

  // Example:
  // "/sys/class/hwmon/hwmon2/fan1_input"
  fanSensorPath: "",
}
