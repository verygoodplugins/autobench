const PCM_WORKLET = `
class PCMRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorderProcessor);
`;

export type Recorder = {
  stop: () => Promise<{ wavBase64: string; durationMs: number }>;
  cancel: () => void;
};

export async function startRecorder(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  const blobUrl = URL.createObjectURL(
    new Blob([PCM_WORKLET], { type: "application/javascript" })
  );
  await ctx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-recorder");
  const frames: Float32Array[] = [];
  let totalSamples = 0;
  node.port.onmessage = (e) => {
    const data = e.data as Float32Array;
    frames.push(data);
    totalSamples += data.length;
  };
  source.connect(node);
  node.connect(ctx.destination);
  const startedAt = performance.now();

  function teardown() {
    try {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
    } catch {}
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => undefined);
  }

  return {
    cancel() {
      teardown();
    },
    async stop() {
      teardown();
      const durationMs = performance.now() - startedAt;
      const merged = new Float32Array(totalSamples);
      let o = 0;
      for (const f of frames) {
        merged.set(f, o);
        o += f.length;
      }
      const wav = encodeWav16k(merged);
      const wavBase64 = await blobToBase64(new Blob([wav]));
      return { wavBase64, durationMs };
    },
  };
}

function encodeWav16k(floats: Float32Array): ArrayBuffer {
  const sampleRate = 16000;
  const numSamples = floats.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  writeStr("RIFF");
  view.setUint32(p, 36 + dataSize, true); p += 4;
  writeStr("WAVE");
  writeStr("fmt ");
  view.setUint32(p, 16, true); p += 4;
  view.setUint16(p, 1, true); p += 2;
  view.setUint16(p, 1, true); p += 2;
  view.setUint32(p, sampleRate, true); p += 4;
  view.setUint32(p, byteRate, true); p += 4;
  view.setUint16(p, blockAlign, true); p += 2;
  view.setUint16(p, 16, true); p += 2;
  writeStr("data");
  view.setUint32(p, dataSize, true); p += 4;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]!));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    p += 2;
  }
  return buffer;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function base64WavToObjectUrl(b64: string, mime = "audio/wav"): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
