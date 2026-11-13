import { VoiceTranscriber } from './voice.js';

const voice = new VoiceTranscriber();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => voice.stop());
console.log(`Preparing local Whisper (${voice.cfg.model}). The first run downloads the speech model and may take several minutes.`);
console.log(`Model folder: ${voice.cfg.modelDirectory}`);
try {
  await voice.prepare();
  if (!voice.status().enabled) throw new Error(voice.status().reason);
  console.log('Voice input is ready. Restart npm start, then refresh the dashboard or send a Telegram voice note.');
} catch (error) {
  console.error(error.message);
  console.error('Setup needs a working whisper/ffmpeg installation and internet access for the first model download.');
  process.exitCode = 1;
}
