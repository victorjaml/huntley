// Logging. Everything goes to stderr so stdout stays clean for --json output,
// and every line is timestamped because these runs happen under cron at 06:30
// and the only way to debug them afterwards is the log.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };
let threshold = LEVELS[process.env.HUNTLEY_LOG_LEVEL ?? 'info'] ?? LEVELS.info;

const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const ESC = '\u001b';
const c = (code, s) => (COLOR ? `${ESC}[${code}m${s}${ESC}[0m` : s);

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, prefix, msg) {
  if (LEVELS[level] < threshold) return;
  process.stderr.write(`${c(90, stamp())} ${prefix} ${msg}\n`);
}

export const log = {
  setLevel(name) { threshold = LEVELS[name] ?? threshold; },
  trace: (m) => emit('trace', c(90, 'trace'), c(90, m)),
  debug: (m) => emit('debug', c(90, 'debug'), m),
  info:  (m) => emit('info',  ' ', m),
  step:  (m) => emit('info',  c(36, '▸'), c(1, m)),
  ok:    (m) => emit('info',  c(32, '✓'), m),
  warn:  (m) => emit('warn',  c(33, '!'), c(33, m)),
  error: (m) => emit('error', c(31, '✗'), c(31, m)),
};
