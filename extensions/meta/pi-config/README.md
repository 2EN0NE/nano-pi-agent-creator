pi-config
==========

Unified configuration store for pi extensions.

Multi-layer config (default → user → project → session), generic deep merge, atomic writes.

Usage
-----

```typescript
import { createConfigStore } from '@zenone/pi-config';

interface MyConfig {
	enabled: boolean;
	retries: number;
}

const store = createConfigStore<MyConfig>({
	pluginName: 'my-extension',
	defaults: { enabled: true, retries: 3 },
});

const cfg = store.get(); // merged from all available layers
store.reload(); // force re-read from disk
store.save(cfg, 'user'); // write to user scope
```

Config layers (highest precedence last)
----------------------------------------

1. **Defaults** — embedded in plugin source code
2. **User** — `~/.pi/agent/extensions-data/<plugin>/config.json`
3. **Project** — `<cwd>/.pi/extensions-data/<plugin>/config.json`
4. **Session** (optional) — `~/.pi/agent/extensions-data/<plugin>/<sessionId>.json`

Each layer deep-merges into the previous (plain-object recursive, array replacement). Interactive UI changes save to the session layer.

Commands
--------

| Command          | Description                                    |
| ---------------- | ---------------------------------------------- |
| `/config`        | List all plugins and their config file status  |
| `/config <name>` | Show detailed layer information for one plugin |
