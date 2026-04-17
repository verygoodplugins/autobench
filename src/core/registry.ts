import type {
  AnyPlugin,
  PluginFactory,
  SlotKind,
  SlotToPlugin,
} from "./types.js";

type RegistryKey = `${SlotKind}:${string}`;

class PluginRegistry {
  private factories = new Map<RegistryKey, PluginFactory<AnyPlugin>>();

  register<K extends SlotKind>(
    kind: K,
    name: string,
    factory: PluginFactory<SlotToPlugin<K>>
  ): void {
    const key: RegistryKey = `${kind}:${name}`;
    if (this.factories.has(key)) {
      throw new Error(`Plugin already registered: ${key}`);
    }
    this.factories.set(key, factory as PluginFactory<AnyPlugin>);
  }

  async create<K extends SlotKind>(
    kind: K,
    name: string,
    config: Record<string, unknown> = {}
  ): Promise<SlotToPlugin<K>> {
    const key: RegistryKey = `${kind}:${name}`;
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(
        `Unknown ${kind} plugin "${name}". Registered: ${this.list(kind).join(", ") || "(none)"}`
      );
    }
    const instance = await factory(config);
    await instance.init(config);
    return instance as SlotToPlugin<K>;
  }

  list(kind?: SlotKind): string[] {
    const out: string[] = [];
    for (const key of this.factories.keys()) {
      const [k, n] = key.split(":", 2) as [SlotKind, string];
      if (!kind || k === kind) out.push(n);
    }
    return out;
  }

  describe(): Record<SlotKind, string[]> {
    return {
      vad: this.list("vad"),
      stt: this.list("stt"),
      llm: this.list("llm"),
      tts: this.list("tts"),
    };
  }
}

export const registry = new PluginRegistry();

export async function loadBuiltins(): Promise<void> {
  await import("../plugins/vad/sox-silence.js");
  await import("../plugins/vad/silero.js");
  await import("../plugins/stt/whisper-server.js");
  await import("../plugins/stt/parakeet.js");
  await import("../plugins/llm/ollama.js");
  await import("../plugins/llm/claude.js");
  await import("../plugins/tts/kokoro.js");
  await import("../plugins/tts/macos-say.js");
  await import("../plugins/tts/piper.js");
}
