# pi-logger: Unified Logging System for pi Extensions

A centralized logging system for pi extensions, inspired by Java's SLF4J/Logback architecture.

## Architecture Overview

```
pi-logger/
├── package.json                 # npm metadata
├── index.ts                     # Extension factory (init + EventBus listener)
├── api.ts                       # Logger API: createLogger() for extensions
├── config.ts                    # Config loader + hierarchical level resolution
├── types.ts                     # Public types (LogLevel, LogEvent, Logger, etc.)
├── appenders/
│   ├── file-appender.ts         # Daily-rotated file output
│   └── console-appender.ts      # Colored console output (stderr)
└── lifecycle-capture.ts         # Auto-capture 15+ lifecycle events
```

Three subsystems work together:

| Subsystem | File | Purpose |
|---|---|---|
| **Logger API** | `api.ts` | Extensions import `createLogger()` and call `.info()`, `.debug()`, etc. |
| **Config Engine** | `config.ts` | Hierarchical per-logger level control via JSON config file |
| **Lifecycle Capture** | `lifecycle-capture.ts` | Auto-log tool/turn/message/agent events for ALL extensions (even npm ones) |

---

## For Extension Developers: Using the Logger API

### 1. Import and create a logger

```typescript
import { createLogger } from '../pi-logger/api.js';

const log = createLogger('my-extension');
```

### 2. Log at your level

```typescript
log.trace('Entering function with args: %s', args);     // verbose debug
log.debug('Processing item #%d', item.id);               // debug info
log.info('Review complete for %s', filePath);             // normal info
log.warn('File %s has %d issues', path, count);           // warnings
log.error('Failed to process: %s', err.message, { err }); // errors
```

### 3. Structured data support

Pass an object as the last argument — it becomes the `details` field:

```typescript
log.info('Processing complete', {
  filePath: 'src/main.ts',
  issues: 3,
  duration: 1500,
});
```

### 4. printf-style formatting

| Specifier | Description |
|---|---|
| `%s` | String |
| `%d` | Number |
| `%j` / `%o` | JSON pretty-printed |
| `%%` | Literal `%` |

### 5. Child loggers (hierarchical naming)

```typescript
const log = createLogger('review');
const scannerLog = childLogger(log, 'file-scanner');
scannerLog.info('Scanning...');   // source = "review.file-scanner"
```

---

## For Extension Developers: Configuring Log Levels

### Config file locations (merged, later takes precedence)

| Priority | Location | Description |
|---|---|---|
| 1 (lowest) | `~/.pi/logger.json` | Global user defaults |
| 2 | `<cwd>/.pi/logger.json` | Project-level overrides |
| 3 (highest) | CLI flag + `/log` commands | Runtime overrides |

### Config file example

```jsonc
{
  "defaultLevel": "info",
  "loggers": {
    "review": "debug",
    "review.file-scanner": "error",
    "sandbox": "warn",
    "__lifecycle__": "info"
  },
  "appenders": {
    "file": {
      "enabled": true,
      "path": "~/.pi/logs",
      "level": "trace"
    },
    "console": {
      "enabled": false,
      "level": "info",
      "color": true
    }
  }
}
```

### Level hierarchy rules

```
Given logger "review.file-scanner":
  1. Exact match "review.file-scanner" → error
  2. No match → walk up to "review" → debug
  3. No match → use "defaultLevel" → info
  4. No default → built-in default "info"
```

---

## Using the `/log` Command

```
/log config                     Show current configuration
/log config reload              Reload config files
/log config level <name>        Show level for a logger
/log config level <name> <lvl>  Set level for a logger
/log tail [n]                   Show last n log entries (default: 20)
/log path                       Show current log file path
/log set-output file|console|both  Change output mode
```

### CLI flags

| Flag | Description |
|---|---|
| `--log-level <level>` | Override default log level at startup |

---

## For Users: What You Get for Free (npm extensions included)

Even without modifying existing extensions, pi-logger automatically captures:

| Event | Log Level | Example Output |
|---|---|---|
| Tool execution start | `trace` | `[tool] → bash  args={"command":"npm test"}` |
| Tool execution end | `info`/`warn` | `[tool] ← bash  3450ms  ✓` |
| Turn start/end | `trace`/`info` | `[turn] ← #3  4789ms` |
| Messages | `trace`/`info` | `[msg] ← assistant` |
| Agent start/end | `info` | `[agent] →` |
| Model select | `info` | `[model] anthropic/claude-sonnet-4` |
| Bash commands | `info` | `[bash] ! npm test` |
| Session events | `info` | `[session] → a1b2c3  reason=startup` |

All lifecycle logs use source `__lifecycle__`, configurable independently:

```json
{ "loggers": { "__lifecycle__": "trace" } }
```

---

## Quick Start

### Load the extension

```bash
pi -e ./pi-logger --log-level debug
```

Or add to `package.json` for zero-config loading:

```json
{
  "pi": {
    "extensions": [
      "./pi-logger"
    ]
  }
}
```

### Install globally (for use across projects)

```bash
cp -r pi-logger ~/.pi/agent/extensions/pi-logger
```

Then load with:

```bash
pi -e pi-logger
```

### Log file output

Default location: `~/.pi/logs/YYYY-MM-DD.log`

```
[2026-01-15T10:30:00.123] [INFO ] [__lifecycle__] [session] → a1b2c3  reason=startup
[2026-01-15T10:30:01.456] [DEBUG] [review] Starting review for src/main.ts
[2026-01-15T10:30:01.789] [TRACE] [__lifecycle__] [tool] → bash  args={"command":"npm test"}
[2026-01-15T10:30:05.234] [TRACE] [__lifecycle__] [tool] ← bash  3450ms  ✓  result=All tests passed
[2026-01-15T10:30:05.567] [INFO ] [__lifecycle__] [turn] ← #3  calls=2  4789ms
```
